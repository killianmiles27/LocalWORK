//! Poison-tolerant locking for the host.
//!
//! A `std::sync::Mutex` (and `RwLock`) is poisoned when a thread panics while holding it, and every
//! later `lock().unwrap()` panics too. Here that took the whole app down: one panicking command, event
//! handler or watchdog thread made every later command that touches the same state panic in turn.
//!
//! Use `guard()` — and `read_guard()`/`write_guard()` for an `RwLock` — instead of `lock().unwrap()`.
//! Recovering the guard is safe for the state behind every lock in this crate, because none of it can be
//! left half-written in a way later code trusts:
//!
//! * `db` is a rusqlite `Connection`. The store runs one statement per call and never keeps a transaction
//!   open, so a panic between two calls cannot leave a partial transaction behind.
//! * `strata::Strata` holds the model child handle and the status text. The monitor thread re-checks both
//!   against the live server (`/health`, `/v1/models`, the `gen` counter), so a field left behind by a
//!   panic is corrected there rather than trusted.
//! * The `agent` locks hold a child handle, a stdin handle and plain bookkeeping (queues, flags, pending
//!   approvals). The reader thread re-reads them for every event; at worst one queue entry is lost.
//! * `stats` is a cache the sampler overwrites, and a sysinfo `System` is refreshed before it is read.
//! * `download`, `engine` and `supervisor` keep registries of ids and pids that are re-read from disk and
//!   only ever added or removed by id, so a half-applied change is retried, not trusted.
//! * `documents::REVISION_LOCK` only serializes snapshots; each revision is an immutable file named after
//!   a fresh id, so an interrupted snapshot is retried or ignored.
//!
//! The first recovery is reported on stderr so a poisoned lock is never silent; the panic that poisoned
//! it has already printed its own message.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

static RECOVERY_REPORTED: AtomicBool = AtomicBool::new(false);

fn recover<T>(error: PoisonError<T>) -> T {
    if !RECOVERY_REPORTED.swap(true, Ordering::Relaxed) {
        eprintln!("a thread panicked while holding a lock; recovered its state and continued");
    }
    error.into_inner()
}

/// `Mutex::lock` that recovers from poisoning instead of panicking.
pub trait LockExt<T: ?Sized> {
    fn guard(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> LockExt<T> for Mutex<T> {
    fn guard(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(recover)
    }
}

/// `RwLock` access with the same recovery as [`LockExt::guard`]. The host uses no `RwLock` today; these
/// exist so a new one uses this instead of `read().unwrap()`.
pub trait RwLockExt<T: ?Sized> {
    fn read_guard(&self) -> RwLockReadGuard<'_, T>;
    fn write_guard(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> RwLockExt<T> for RwLock<T> {
    fn read_guard(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(recover)
    }

    fn write_guard(&self) -> RwLockWriteGuard<'_, T> {
        self.write().unwrap_or_else(recover)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_panic_while_holding_a_mutex_does_not_break_later_locks() {
        let state = Arc::new(Mutex::new(vec![1]));
        let holder = state.clone();
        let panicked = std::thread::spawn(move || {
            let mut g = holder.guard();
            g.push(2);
            panic!("a command panicked while holding the lock");
        })
        .join();
        assert!(panicked.is_err(), "the thread must have panicked");
        // This is what used to kill the app: the mutex is poisoned, and `lock().unwrap()` would panic.
        assert!(state.lock().is_err(), "the panic polluted the mutex");
        state.guard().push(3);
        assert_eq!(*state.guard(), vec![1, 2, 3]);
        // The recovered state is usable for writing through the same guard type.
        state.guard().retain(|v| *v != 2);
        assert_eq!(*state.guard(), vec![1, 3]);
    }

    #[test]
    fn a_panic_while_holding_an_rwlock_does_not_break_later_locks() {
        let state = Arc::new(RwLock::new(String::from("a")));
        let holder = state.clone();
        let panicked = std::thread::spawn(move || {
            let mut g = holder.write_guard();
            g.push('b');
            panic!("a command panicked while holding the write lock");
        })
        .join();
        assert!(panicked.is_err());
        assert!(state.read().is_err(), "the panic polluted the rwlock");
        assert_eq!(&*state.read_guard(), "ab");
        state.write_guard().push('c');
        assert_eq!(&*state.read_guard(), "abc");
    }
}

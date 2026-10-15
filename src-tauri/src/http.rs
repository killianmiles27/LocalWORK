//! Just enough HTTP/1.1 to poll the local Strata server without pulling in a client stack.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub fn get(port: u16, path: &str, bearer: Option<&str>, timeout: Duration) -> Option<(u16, String)> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(k) = bearer {
        req.push_str(&format!("Authorization: Bearer {k}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Some((status, body))
}

pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(18080)
}

/// POST a JSON body and return (status, body). Handles `Transfer-Encoding: chunked` replies.
pub fn post_json(port: u16, path: &str, bearer: Option<&str>, body: &str, timeout: Duration) -> Option<(u16, String)> {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(10))).ok()?;
    let mut req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(k) = bearer {
        req.push_str(&format!("Authorization: Bearer {k}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(body);
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let raw = &buf[split + 4..];
    let status = head.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    let chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let bytes = if chunked { dechunk(raw) } else { raw.to_vec() };
    Some((status, String::from_utf8_lossy(&bytes).to_string()))
}

fn dechunk(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(nl) = raw.windows(2).position(|w| w == b"\r\n") else { break };
        let size = usize::from_str_radix(String::from_utf8_lossy(&raw[..nl]).split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        raw = &raw[nl + 2..];
        if size == 0 || raw.len() < size {
            out.extend_from_slice(&raw[..raw.len().min(size)]);
            break;
        }
        out.extend_from_slice(&raw[..size]);
        raw = raw.get(size + 2..).unwrap_or(&[]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn post_json_reads_chunked_reply() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = c.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("POST /v1/chat/completions"));
            assert!(req.contains("Authorization: Bearer k"));
            assert!(req.ends_with("{\"a\":1}"));
            c.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n").unwrap();
        });
        let (code, body) = post_json(port, "/v1/chat/completions", Some("k"), "{\"a\":1}", Duration::from_secs(5)).unwrap();
        t.join().unwrap();
        assert_eq!((code, body.as_str()), (200, "hello world"));
    }
}

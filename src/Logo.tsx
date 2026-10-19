// The LocalWORK mark: same geometry as public/icon.svg and scripts/make-icons.py.
export default function Logo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#3a47c4" />
      <circle cx="41" cy="14" r="4.5" fill="#d9663a" />
      <polyline points="12,50 24,33 31,41 41,24 53,50" fill="none" stroke="#fff" strokeWidth="6.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

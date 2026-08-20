// Minimal hand-picked line icons — avoids pulling in an icon library for ~8 glyphs.
const PATHS = {
  rocket: "M12 2c2.5 2 4 5.5 4 9 0 1.9-.4 3.4-1 4.7L12 22l-3-6.3C8.4 14.4 8 12.9 8 11c0-3.5 1.5-7 4-9z M9 16l-3 3M15 16l3 3M10 9a2 2 0 104 0 2 2 0 00-4 0z",
  compass: "M12 22a10 10 0 100-20 10 10 0 000 20zM15 9l-2 6-6 2 2-6 6-2z",
  briefcase: "M4 8h16v11H4zM9 8V6a2 2 0 012-2h2a2 2 0 012 2v2M4 13h16",
  code: "M9 18l-6-6 6-6M15 6l6 6-6 6",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  flask: "M9 3h6M10 3v6l-5 9a1.5 1.5 0 001.3 2.2h11.4A1.5 1.5 0 0019 18l-5-9V3",
  "check-shield": "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4",
  stop: "M6 6h12v12H6z",
  info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6M12 7v.01",
};

export default function Icon({ name, size = 18, className = "" }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d={d} />
    </svg>
  );
}

type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <path
        className="brand-thread"
        d="M51 13H27C18 13 12 18 12 25.5S18 38 27 38H37C46 38 52 43 52 50.5S46 59 38 59H13"
      />
      <path
        className="brand-state"
        d="M12 25.5C12 33 18 38 27 38H31"
      />
    </svg>
  );
}

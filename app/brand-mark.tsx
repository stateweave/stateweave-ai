type BrandMarkProps = {
  className?: string;
};

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <path className="brand-warp" d="M5 5a2 2 0 0 1 4 0v22a2 2 0 0 1-4 0V5Zm9 0a2 2 0 0 1 4 0v22a2 2 0 0 1-4 0V5Zm9 0a2 2 0 0 1 4 0v22a2 2 0 0 1-4 0V5Z" />
      <path className="brand-weft" d="M4.5 13h23a3 3 0 0 1 0 6h-23a3 3 0 0 1 0-6Z" />
      <path className="brand-over" d="M5 12.5h4v7H5v-7Zm18 0h4v7h-4v-7Z" />
    </svg>
  );
}

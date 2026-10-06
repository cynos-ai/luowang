export function BrandLogo({
  tone = 'color',
  size = 'header',
  decorative = false,
}: {
  tone?: 'color' | 'white';
  size?: 'header' | 'hero';
  decorative?: boolean;
}) {
  return (
    <img
      className={`brand-logo brand-logo--${size}`}
      src={`/brand/logo-${tone}.png`}
      width={600}
      height={tone === 'color' ? 246 : 245}
      alt={decorative ? '' : '罗网 LuoWang'}
      draggable={false}
    />
  );
}

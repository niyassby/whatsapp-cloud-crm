import type { TagDto } from '@wacrm/shared';

export function TagChip({ tag }: { tag: TagDto }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
      <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />
      {tag.name}
    </span>
  );
}

import { renderTemplate, type TemplateDefinition } from '@wacrm/shared';
import { Copy, ExternalLink, FileText, ImageIcon, Phone, Reply, Video } from 'lucide-react';

const BUTTON_ICON = { QUICK_REPLY: Reply, URL: ExternalLink, PHONE_NUMBER: Phone, COPY_CODE: Copy };
const MEDIA_ICON = { IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText };

/** Roughly what the customer sees on their phone, filled with the given values. */
export function TemplatePreview({
  definition,
  values,
  mediaUrl,
  mediaName,
}: {
  definition: TemplateDefinition;
  values: Record<string, string>;
  /** A local or signed link to the header file, once there is one. */
  mediaUrl?: string | null;
  mediaName?: string | null;
}) {
  const rendered = renderTemplate(definition, values);
  const header = definition.header;
  const MediaIcon = header && header.format !== 'TEXT' ? MEDIA_ICON[header.format] : null;

  return (
    <div
      className="rounded-lg bg-[#efeae2] p-3 dark:bg-[#0b141a]"
      role="group"
      aria-label="Message preview"
    >
      <div className="max-w-[20rem] overflow-hidden rounded-lg bg-white text-sm text-black shadow-sm dark:bg-[#202c33] dark:text-white">
        {MediaIcon &&
          (header?.format === 'IMAGE' && mediaUrl ? (
            <img src={mediaUrl} alt="Header" className="max-h-44 w-full object-cover" />
          ) : (
            <div className="flex h-28 flex-col items-center justify-center gap-1 bg-black/10 text-xs text-black/60 dark:bg-white/10 dark:text-white/60">
              <MediaIcon className="size-6" aria-hidden />
              {mediaName ?? `${header?.format.toLowerCase()} header`}
            </div>
          ))}
        <div className="grid gap-1 p-2.5">
          {rendered.header && <p className="font-semibold break-words">{rendered.header}</p>}
          <p className="whitespace-pre-wrap break-words">{rendered.body}</p>
          {rendered.footer && <p className="text-xs opacity-60">{rendered.footer}</p>}
        </div>
        {definition.buttons.length > 0 && (
          <ul className="border-t border-black/10 dark:border-white/10">
            {definition.buttons.map((b, i) => {
              const Icon = BUTTON_ICON[b.type];
              return (
                <li
                  key={i}
                  className="flex items-center justify-center gap-1.5 border-b border-black/10 p-2 text-[#027eb5] last:border-0 dark:border-white/10 dark:text-[#53bdeb]"
                >
                  <Icon className="size-3.5" aria-hidden />
                  {b.type === 'COPY_CODE' ? 'Copy offer code' : b.text}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

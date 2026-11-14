'use client';

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 40 };

function niceMax(value: number) {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
}

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * Customer messages by hour of the day: one series, so no legend (the title names it). Same
 * validated blue as the volume chart, in both modes. Bars have rounded tops on the baseline, a
 * 2px gap, a tooltip on hover or arrow keys, and a table view.
 */
export function HourChart({ hours }: { hours: { hour: number; inbound: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [asTable]);

  const top = niceMax(Math.max(0, ...hours.map((h) => h.inbound)));
  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const slot = innerW / 24;
  const barW = Math.max(2, slot - 2);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const ticks = [0, 0.5, 1].map((f) => f * top);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    setHover((h) => Math.min(23, Math.max(0, (h ?? (step > 0 ? -1 : 24)) + step)));
  };
  const point = hover === null ? null : hours[hover];

  return (
    <div className="flex flex-col gap-2 [--series-1:#2a78d6] dark:[--series-1:#3987e5]">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'View as chart' : 'View as table'}
        </Button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hour</TableHead>
                <TableHead className="text-right">From customers</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hours.map((h) => (
                <TableRow key={h.hour}>
                  <TableCell>{hourLabel(h.hour)}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.inbound}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div
          ref={ref}
          className="relative outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
          role="img"
          aria-label="Messages from customers by hour of the day. Use the arrow keys to read each hour."
          onKeyDown={onKey}
          onMouseLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
        >
          <svg width={width} height={HEIGHT} aria-hidden>
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + innerW}
                  y1={y(t)}
                  y2={y(t)}
                  className="stroke-border"
                  strokeDasharray={t === 0 ? undefined : '2 4'}
                />
                <text
                  x={PAD.left - 6}
                  y={y(t)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {t.toLocaleString()}
                </text>
              </g>
            ))}
            {hours.map((h, i) => {
              const x = PAD.left + i * slot + 1;
              const barH = Math.max(0, PAD.top + innerH - y(h.inbound));
              const r = Math.min(4, barW / 2, barH);
              const base = PAD.top + innerH;
              return (
                <g key={h.hour} onMouseEnter={() => setHover(i)}>
                  {/* The hit target is the whole column, bigger than the bar. */}
                  <rect x={x - 1} y={PAD.top} width={slot} height={innerH} fill="transparent" />
                  {barH > 0 ? (
                    <path
                      d={`M${x},${base} V${base - barH + r} Q${x},${base - barH} ${x + r},${base - barH} H${x + barW - r} Q${x + barW},${base - barH} ${x + barW},${base - barH + r} V${base} Z`}
                      fill="var(--series-1)"
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  ) : null}
                  {i % 3 === 0 ? (
                    <text
                      x={x + barW / 2}
                      y={HEIGHT - 6}
                      textAnchor="middle"
                      className="fill-muted-foreground text-[11px]"
                    >
                      {String(h.hour).padStart(2, '0')}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {point ? (
            <div
              className="pointer-events-none absolute top-0 rounded-md border bg-popover px-2 py-1 text-xs shadow-sm"
              style={{
                left: Math.min(width - 130, Math.max(0, PAD.left + (hover ?? 0) * slot - 40)),
              }}
            >
              <div className="font-medium">{hourLabel(point.hour)}</div>
              <div className="tabular-nums text-muted-foreground">
                {point.inbound.toLocaleString()} from customers
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

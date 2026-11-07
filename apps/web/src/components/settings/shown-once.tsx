'use client';

import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** A secret the server will never show again. */
export function ShownOnce({
  title,
  value,
  onDone,
}: {
  title: string;
  value: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>Copy it now. For your security it will not be shown again.</span>
        <code
          className="block rounded bg-muted p-2 font-mono text-xs break-all text-foreground"
          data-testid="shown-once-value"
        >
          {value}
        </code>
        <span className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(value).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDone}>
            Done
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

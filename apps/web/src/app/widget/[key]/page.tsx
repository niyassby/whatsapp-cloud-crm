'use client';

import {
  WEBCHAT_NAMESPACE,
  type WebchatMessageDto,
  type WebchatServerEvents,
  type WebchatSessionDto,
  SOCKET_PATH,
} from '@wacrm/shared';
import { useParams, useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { env } from '@/lib/env';

/**
 * The website chat, inside the iframe the embed script adds. It runs on the app's origin, so the
 * host site cannot read it. The visitor's token is kept in this origin's storage.
 */

const storageKey = (key: string) => `wacrm-chat:${key}`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/webchat/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error(data?.message ?? 'Something went wrong');
  return data as T;
}

/** The page embedding the widget: the browser's own record where it has one. */
function parentOrigin(fallback: string | null): string | undefined {
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList })
    .ancestorOrigins;
  return ancestors?.[0] ?? fallback ?? undefined;
}

function Chat() {
  const { key } = useParams<{ key: string }>();
  const search = useSearchParams();
  const [session, setSession] = useState<WebchatSessionDto | null>(null);
  const [messages, setMessages] = useState<WebchatMessageDto[]>([]);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<Socket<WebchatServerEvents, { join: () => void }> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const add = useCallback((m: WebchatMessageDto) => {
    setMessages((all) => (all.some((x) => x.id === m.id) ? all : [...all, m]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      let saved: string | undefined;
      try {
        saved = localStorage.getItem(storageKey(key)) ?? undefined;
      } catch {
        saved = undefined;
      }
      try {
        const s = await post<WebchatSessionDto>(`${key}/session`, {
          token: saved,
          origin: parentOrigin(search.get('origin')),
        });
        if (cancelled) return;
        try {
          localStorage.setItem(storageKey(key), s.token);
        } catch {
          // Private windows: the chat still works, it just starts fresh next time.
        }
        setSession(s);
        if (s.started)
          setMessages(await post<WebchatMessageDto[]>(`${key}/history`, { token: s.token }));
        const socket: Socket<WebchatServerEvents, { join: () => void }> = io(
          `${env.NEXT_PUBLIC_API_URL}${WEBCHAT_NAMESPACE}`,
          { path: SOCKET_PATH, auth: { key, token: s.token } },
        );
        socket.on('message:new', ({ message }) => add(message));
        socketRef.current = socket;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'This chat is not available');
      }
    };
    void start();
    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
    };
  }, [key, search, add]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = async (body: string, replyId?: string) => {
    if (!session || !body.trim()) return;
    setBusy(true);
    try {
      const first = !session.started;
      const message = await post<WebchatMessageDto>(`${key}/messages`, {
        token: session.token,
        clientMessageId: crypto.randomUUID(),
        body: body.trim(),
        ...(replyId ? { replyId } : {}),
        ...(first && name.trim() ? { name: name.trim() } : {}),
        ...(first && email.trim() ? { email: email.trim() } : {}),
      });
      add(message);
      setText('');
      if (first) {
        setSession({ ...session, started: true });
        // There is a conversation now: join its room for replies.
        socketRef.current?.emit('join');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Not sent');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  if (error && !session) {
    return <p className="p-4 text-sm text-neutral-600">{error}</p>;
  }
  if (!session) return <p className="p-4 text-sm text-neutral-500">Loading…</p>;
  const needsDetails = session.channel.askDetails && !session.started;
  return (
    <div className="flex h-screen flex-col bg-white text-neutral-900">
      <header className="px-4 py-3 text-white" style={{ background: session.channel.color }}>
        <h1 className="text-base font-semibold">{session.channel.title}</h1>
      </header>
      <div
        ref={listRef}
        className="flex flex-1 flex-col gap-2 overflow-y-auto p-3"
        role="log"
        aria-live="polite"
      >
        <p className="max-w-[85%] self-start rounded-lg bg-neutral-100 px-3 py-2 text-sm">
          {session.channel.greeting}
        </p>
        {messages.map((m) => (
          <div key={m.id} className={m.from === 'visitor' ? 'self-end' : 'self-start'}>
            {m.body && (
              <p
                className={
                  'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ' +
                  (m.from === 'visitor' ? 'text-white' : 'bg-neutral-100')
                }
                style={m.from === 'visitor' ? { background: session.channel.color } : undefined}
              >
                {m.body}
              </p>
            )}
            {m.buttons.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {m.buttons.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    disabled={busy}
                    className="rounded-full border px-3 py-1 text-xs hover:bg-neutral-50"
                    onClick={() => void send(b.title, b.id)}
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="px-3 text-xs text-red-600">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-2 border-t p-2">
        {needsDetails && (
          <div className="flex gap-2">
            <input
              aria-label="Your name"
              placeholder="Your name"
              className="h-9 flex-1 rounded-md border px-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              aria-label="Your email"
              type="email"
              placeholder="Email"
              className="h-9 flex-1 rounded-md border px-2 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        )}
        <div className="flex gap-2">
          <input
            aria-label="Message"
            placeholder="Type a message"
            className="h-10 flex-1 rounded-md border px-3 text-sm"
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy || !text.trim() || (needsDetails && !name.trim())}
            className="rounded-md px-4 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: session.channel.color }}
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

export default function WidgetPage() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}

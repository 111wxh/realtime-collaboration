'use client';

/**
 * 通用 UI 小件：加载态、错误条、空状态、头像、复制按钮。
 * 样式基类在 app/globals.css（.ui-btn / .ui-input / .ui-card）。
 */
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-4 w-4 animate-spin', className)} aria-hidden />;
}

/** 整屏加载 / 跳转提示 */
export function FullscreenHint({ text }: { text: string }) {
  return (
    <div className="grid min-h-dvh place-items-center p-8">
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner />
        <span>{text}</span>
      </div>
    </div>
  );
}

export function ErrorBanner({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={clsx(
        'flex items-start justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger',
        className,
      )}
    >
      <span>{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-xs text-danger/80 hover:text-danger"
        >
          关闭
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-line bg-panel px-6 py-12 text-center">
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

/** 成员头像：取显示名首字，底色用服务端的 avatarColor */
export function Avatar({
  name,
  color,
  size = 32,
  title,
}: {
  name: string;
  color: string;
  size?: number;
  title?: string;
}) {
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  return (
    <span
      title={title ?? name}
      className="inline-grid shrink-0 place-items-center rounded-full font-medium text-white ring-2 ring-panel"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: Math.max(11, Math.round(size * 0.42)),
      }}
    >
      {initial}
    </span>
  );
}

/** 复制到剪贴板的小按钮（带"已复制"反馈） */
export function CopyButton({ value, label = '复制邀请码' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ui-btn h-8 px-2 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M20 6 9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
          <path
            d="M5 15V5a2 2 0 0 1 2-2h10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
      {copied ? '已复制' : label}
    </button>
  );
}

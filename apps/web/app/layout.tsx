import type { Metadata } from 'next';

import { SessionBootstrapper } from '../components/SessionBootstrapper';

import './globals.css';

export const metadata: Metadata = {
  title: '协作白板',
  description: '实时多人协作白板 —— 画布、光标、在线状态与断线补齐',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {/* 应用启动时尝试用 refresh cookie 恢复会话（access token 只在内存里） */}
        <SessionBootstrapper />
        {children}
      </body>
    </html>
  );
}

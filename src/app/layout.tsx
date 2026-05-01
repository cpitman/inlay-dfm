import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Inlay DFM Analyzer',
  description: 'Design for Manufacturing analysis for CNC VCarve inlay designs',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full flex flex-col bg-slate-900 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}

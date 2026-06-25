import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "82AD Talent Spotter",
  description: "CRCON match scanner for spotting high-KPM Hell Let Loose players.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

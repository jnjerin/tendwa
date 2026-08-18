import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tendwa",
  description: "Compound memory for incident response",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <Link href="/" className="nav-brand">
            Tendwa
          </Link>
          <Link href="/" className="nav-link">
            Incidents
          </Link>
          <Link href="/knowledge" className="nav-link">
            Knowledge
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}

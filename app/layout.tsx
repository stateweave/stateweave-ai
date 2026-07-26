import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://stateweave.ai"),
  title: "StateWeave",
  description: "A graph-native agent that keeps the whole picture in mind.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "StateWeave",
    title: "StateWeave — What should not be lost?",
    description: "A graph-native agent that keeps the connections alive.",
    images: [{
      url: "/stateweave-social-card.png",
      width: 1200,
      height: 630,
      alt: "StateWeave causal graph woven from connected threads",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "StateWeave — What should not be lost?",
    description: "A graph-native agent that keeps the connections alive.",
    images: [{
      url: "/stateweave-social-card.png",
      alt: "StateWeave causal graph woven from connected threads",
    }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f5ed" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1510" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Inventory", description: "Your belongings, purchases, and what they mean to you.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}

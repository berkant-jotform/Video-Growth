import "./globals.css";
import { Analytics } from '@vercel/analytics/next';

export const metadata = {
  title: "YouTube A/B Tests",
  description: "Cloud test finish detector for YouTube A/B tests"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}

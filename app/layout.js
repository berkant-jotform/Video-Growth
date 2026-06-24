import "./globals.css";

export const metadata = {
  title: "YouTube A/B Tests",
  description: "Cloud test finish detector for YouTube A/B tests"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

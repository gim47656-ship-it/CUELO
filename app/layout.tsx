import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/PwaRegistration";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "CUELO",
  description: "Web view for the omp (oh-my-pi) coding agent",
  applicationName: "CUELO",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "CUELO",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  // Matches SEED's `bg.layer-default` in each color mode: light resolves to
  // gray-00 (#ffffff), dark to gray-100 (#16171b). @seed-design/css owns the
  // values; these two literals only exist because the meta tag cannot read a
  // custom property.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#16171b" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      translate="no"
      className="notranslate"
      data-seed
      suppressHydrationWarning
    >
      <head>
        <meta name="google" content="notranslate" />
        <meta name="color-scheme" content="light dark" />
        {/* Paints the resolved color mode before hydration. `data-seed-color-mode`
            is what @seed-design/css switches its token scheme on; `.dark` and
            `data-omp-theme-mode` remain for this app's own selectors. This is the
            same rule the client applies in hooks/useTheme.ts: the stored
            preference (`pi-theme`) decides, and `auto`, a missing key or an
            unrecognised value resolve through the system scheme; the legacy
            resolved-mode key (`omp-theme`) only keeps a pre-`pi-theme` install on
            the mode it stored. The mode is applied before the cached palette is
            read, so unreadable storage for the palette cannot leave the first
            paint on SEED's default. Any inline custom property left by an older
            build's palette is removed first, and only the markdown accents
            (`--omp-md-*`) are written back — surface colors come from SEED tokens
            alone. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage,p=s.getItem("pi-theme");if(p!=="light"&&p!=="dark"&&p!=="auto"){p=s.getItem("omp-theme");if(p!=="light"&&p!=="dark")p="auto"}var m=p==="auto"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p,r=document.documentElement;r.dataset.ompThemeMode=m;r.setAttribute("data-seed-color-mode",m==="dark"?"dark-only":"light-only");r.classList.toggle("dark",m==="dark");for(var i=r.style.length-1;i>=0;i--){var n=r.style.item(i);if(n.indexOf("--")===0&&n.indexOf("--omp-md-")!==0)r.style.removeProperty(n)}var c=JSON.parse(s.getItem("omp-theme-config")||"null"),v=c&&c.palettes&&c.palettes[m];if(v&&v.variables){Object.keys(v.variables).forEach(function(k){if(k.indexOf("--omp-md-")===0)r.style.setProperty(k,v.variables[k])});r.dataset.ompThemeName=v.name}}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate">
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}

import { defineConfig } from "vitepress";

export default defineConfig({
  title: "oh-my-matrix",
  description: "OpenClaw-native orchestration — documentation & design repository",
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "Roadmap", link: "/guide/roadmap" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Design Reference", link: "/reference/" },
            {
              text: "ADRs",
              items: [
                {
                  text: "ADR-002: Team Delegation to Host",
                  link: "/reference/adrs/002",
                },
              ],
            },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/TeFuirnever/oh-my-matrix" },
    ],
  },
});

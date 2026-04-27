import { defineConfig } from "vitepress";

export default defineConfig({
  title: "oh-my-matrix",
  description: "OpenClaw-native orchestration extension suite",
  ignoreDeadLinks: true,
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/" },
      { text: "ADRs", link: "/reference/adrs/001" },
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
          items: [{ text: "Tool Index", link: "/reference/" }],
        },
        {
          text: "Contracts",
          items: [
            { text: "Error Codes", link: "/reference/contracts/error-codes" },
            { text: "Hooks", link: "/reference/contracts/hooks" },
            {
              text: "Observability",
              link: "/reference/contracts/observability",
            },
            {
              text: "MCP Protocol",
              link: "/reference/contracts/mcp-protocol",
            },
            { text: "State", link: "/reference/contracts/state-contract" },
            {
              text: "Workflow State",
              link: "/reference/contracts/workflow-state",
            },
          ],
        },
        {
          text: "ADRs",
          items: [
            {
              text: "ADR-001: Pure Plugin, No CLI",
              link: "/reference/adrs/001",
            },
            {
              text: "ADR-002: Team Delegation to Host",
              link: "/reference/adrs/002",
            },
            {
              text: "ADR-003: Zero-Dependency MCP",
              link: "/reference/adrs/003",
            },
            {
              text: "ADR-004: Three-Mode State Machine",
              link: "/reference/adrs/004",
            },
            {
              text: "ADR-005: Cross-Process Locking",
              link: "/reference/adrs/005",
            },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/your-org/oh-my-matrix" },
    ],
  },
});

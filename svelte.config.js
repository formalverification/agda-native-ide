// File: svelte.config.js
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// svelte.config.js at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  kit.version.name is the source revision the
// Makefile and the flake pass in SITE_REVISION, rather than SvelteKit's
// default, the time of the build, so that two builds of one commit are
// byte-identical (issue 3).  Without SITE_REVISION, the default stands.

import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  compilerOptions: {
    warningFilter(warning) {
      const ignored = [
        "a11y_click_events_have_key_events",
        "a11y_no_static_element_interactions",
      ];
      // add keys in `configuration.svelte.plugin.svelte.compilerWarnings`
      // like: "a11y_...": "ignore"
      return !ignored.includes(warning.code);
    },
  },
  kit: {
    adapter: adapter({ precompress: false }),
    version: { name: process.env.SITE_REVISION || undefined },
  },
};

export default config;

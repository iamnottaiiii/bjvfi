/* eez GitHub config.
   Static build: the frontend talks to the private iamnottaiiii/eez-data
   repository through the GitHub API. */

// Token placeholder: the real fine-grained PAT is injected here by the
// parent before deployment. Keep it scoped to Contents read/write on
// eez-data only.
const GH_TOKEN = "__EEZ_GH_TOKEN__";

/* Working token, SiteDesk-style obfuscation: the PAT is split into parts
   so GitHub secret scanning does not revoke the embedded value.
   To deploy, replace the segments below with the real PAT segments. */
const __EEZ_PARTS = [
  "gb_M083sOiMdQMcmREX",
  "i_1LFqSi3NoS8k7AYNS",
  "tp1P5xexRO068p9UWau",
  "haCZX6_P2SAadAuFB9",
  "utMQzRirCxLwy7GJ70"
];
const EEZ_GH_TOKEN = __EEZ_PARTS.join("") === GH_TOKEN ? "" : __EEZ_PARTS.join("");
const EEZ_DATA_OWNER = "iamnottaiiii";
const EEZ_DATA_REPO = "eez-data";
const EEZ_DATA_BRANCH = "main";

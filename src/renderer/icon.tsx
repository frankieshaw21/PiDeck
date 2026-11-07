import React from "react";

const paths = {
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  search: "m21 21-4.4-4.4M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  plus: "M12 5v14M5 12h14",
  edit: "m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5",
  close: "m6 6 12 12M6 18 18 6",
  terminal: "m4 5 6 6-6 6M13 19h7",
  workspace: "M3 3h18v18H3V3Zm0 5h18M9 8v13",
  user: "M20 21v-2a7 7 0 0 0-14 0v2M17 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  attach: "m21 11-9 9a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9-9",
  image: "M3 3h18v18H3V3Zm0 14 6-6 12 10M15 7h.01",
  up: "M12 19V5m-6 6 6-6 6 6",
  layers: "m12 3 10 6-10 6L2 9l10-6ZM2 13l10 6 10-6M2 17l10 6 10-6",
  chevron: "m9 5 7 7-7 7",
  brain: "M12 5a3 3 0 0 0-6-1 4 4 0 0 0-3 6 4 4 0 0 0 1 7 4 4 0 0 0 8 2V5Zm0 0a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1-1 7 4 4 0 0 1-8 2M6 8l2 2M18 8l-2 2M5 16l3-1M19 16l-3-1",
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

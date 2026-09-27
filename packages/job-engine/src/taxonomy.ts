/**
 * Skill taxonomy: canonical names, aliases/synonyms and "related" links.
 *
 * - Aliases collapse spelling variants (ReactJS -> React, JS -> JavaScript).
 * - Related skills are NOT equal: a related match earns partial credit only.
 * - Admins can extend aliases at runtime via registerSkillAliases() (the web app
 *   loads rows from the SkillAlias table on start-up).
 */

export interface SkillDefinition {
  canonical: string;
  aliases: string[];
  related: string[];
  category:
    | "language"
    | "frontend"
    | "backend"
    | "data"
    | "cloud"
    | "devops"
    | "testing"
    | "mobile"
    | "media"
    | "concept"
    | "design"
    | "tooling";
}

const BASE_SKILLS: SkillDefinition[] = [
  // Languages
  { canonical: "JavaScript", aliases: ["js", "javascript", "ecmascript", "es6", "es2015+", "vanilla js"], related: ["TypeScript"], category: "language" },
  { canonical: "TypeScript", aliases: ["typescript", "ts"], related: ["JavaScript"], category: "language" },
  { canonical: "Python", aliases: ["python", "python3"], related: [], category: "language" },
  { canonical: "Java", aliases: ["java"], related: ["Kotlin"], category: "language" },
  { canonical: "Kotlin", aliases: ["kotlin"], related: ["Java"], category: "language" },
  { canonical: "Go", aliases: ["golang", "go lang"], related: [], category: "language" },
  { canonical: "Rust", aliases: ["rust"], related: [], category: "language" },
  { canonical: "C++", aliases: ["c++", "cpp"], related: [], category: "language" },
  { canonical: "C#", aliases: ["c#", "csharp", ".net", "dotnet"], related: [], category: "language" },
  { canonical: "SQL", aliases: ["sql"], related: ["PostgreSQL", "MySQL"], category: "data" },
  { canonical: "HTML", aliases: ["html", "html5", "semantic html"], related: ["CSS"], category: "frontend" },
  { canonical: "CSS", aliases: ["css", "css3", "scss", "sass", "less"], related: ["Tailwind CSS", "HTML"], category: "frontend" },

  // Frontend
  { canonical: "React", aliases: ["react", "react.js", "reactjs", "react js", "react hooks"], related: ["Next.js", "Preact", "React Native", "Vue.js"], category: "frontend" },
  { canonical: "Next.js", aliases: ["next.js", "nextjs", "next js"], related: ["React", "Remix"], category: "frontend" },
  { canonical: "Remix", aliases: ["remix"], related: ["Next.js"], category: "frontend" },
  { canonical: "Preact", aliases: ["preact"], related: ["React"], category: "frontend" },
  { canonical: "Vue.js", aliases: ["vue", "vue.js", "vuejs", "nuxt", "nuxt.js"], related: ["React", "Angular"], category: "frontend" },
  { canonical: "Angular", aliases: ["angular", "angularjs", "angular.js"], related: ["Vue.js", "React"], category: "frontend" },
  { canonical: "Svelte", aliases: ["svelte", "sveltekit"], related: ["React"], category: "frontend" },
  { canonical: "Redux", aliases: ["redux", "redux toolkit", "rtk"], related: ["State management", "Zustand", "MobX"], category: "frontend" },
  { canonical: "Zustand", aliases: ["zustand"], related: ["Redux", "State management"], category: "frontend" },
  { canonical: "MobX", aliases: ["mobx"], related: ["Redux", "State management"], category: "frontend" },
  { canonical: "State management", aliases: ["state management", "state-management", "application state", "global state"], related: ["Redux", "Zustand", "MobX", "XState"], category: "concept" },
  { canonical: "XState", aliases: ["xstate", "state machines", "statecharts"], related: ["State management"], category: "frontend" },
  { canonical: "Tailwind CSS", aliases: ["tailwind", "tailwindcss", "tailwind css"], related: ["CSS"], category: "frontend" },
  { canonical: "Webpack", aliases: ["webpack"], related: ["Vite"], category: "tooling" },
  { canonical: "Vite", aliases: ["vite"], related: ["Webpack"], category: "tooling" },
  { canonical: "GraphQL", aliases: ["graphql", "apollo", "apollo client", "relay"], related: ["REST API"], category: "backend" },
  { canonical: "REST API", aliases: ["rest", "restful", "rest api", "rest apis", "restful api", "restful apis", "restful services"], related: ["GraphQL"], category: "backend" },
  { canonical: "Web accessibility", aliases: ["accessibility", "a11y", "wcag", "aria"], related: ["HTML"], category: "frontend" },
  { canonical: "Design systems", aliases: ["design system", "design systems", "component library", "storybook"], related: ["React"], category: "frontend" },
  { canonical: "Micro-frontends", aliases: ["micro-frontends", "micro frontends", "module federation"], related: ["Webpack"], category: "frontend" },
  { canonical: "Web Workers", aliases: ["web workers", "web worker", "service workers", "service worker"], related: ["Rendering performance"], category: "frontend" },
  { canonical: "WebSockets", aliases: ["websocket", "websockets", "socket.io", "real-time"], related: [], category: "backend" },
  { canonical: "PWA", aliases: ["pwa", "progressive web app", "progressive web apps"], related: ["Web Workers"], category: "frontend" },

  // Canvas / graphics / media
  { canonical: "Canvas API", aliases: ["canvas", "html5 canvas", "canvas api", "canvas-based ui", "canvas based ui", "2d canvas", "konva", "fabric.js"], related: ["WebGL", "SVG"], category: "media" },
  { canonical: "WebGL", aliases: ["webgl", "webgl2", "three.js", "threejs", "pixijs", "pixi.js", "webgpu"], related: ["Canvas API"], category: "media" },
  { canonical: "SVG", aliases: ["svg", "d3", "d3.js"], related: ["Canvas API"], category: "media" },
  { canonical: "Video editing timelines", aliases: ["video timeline", "video timelines", "timeline editor", "video editing timeline", "video editing timelines", "timeline-based editor", "multi-track timeline", "non-linear editor"], related: ["Media workflows", "Canvas API", "WebCodecs"], category: "media" },
  { canonical: "Media workflows", aliases: ["media workflows", "media workflow", "media pipeline", "media pipelines", "video processing", "transcoding", "ffmpeg", "video streaming", "hls"], related: ["Video editing timelines", "Chunked uploads"], category: "media" },
  { canonical: "WebCodecs", aliases: ["webcodecs", "media source extensions", "mse", "webrtc"], related: ["Media workflows"], category: "media" },
  { canonical: "Chunked uploads", aliases: ["chunked upload", "chunked uploads", "resumable upload", "resumable uploads", "multipart upload", "multipart uploads", "tus protocol", "large file uploads"], related: ["Amazon S3", "Media workflows"], category: "concept" },
  { canonical: "Rendering performance", aliases: ["rendering performance", "render performance", "web performance", "frontend performance", "performance optimization", "performance optimisation", "core web vitals", "virtualization", "virtualised lists", "virtualized lists"], related: ["Web Workers", "React"], category: "concept" },
  { canonical: "Complex UI workflows", aliases: ["complex ui", "complex ui workflows", "complex workflows", "workflow builder", "workflow ui", "multi-step workflows", "drag and drop", "drag-and-drop"], related: ["State management", "Design systems"], category: "concept" },

  // Backend
  { canonical: "Node.js", aliases: ["node", "node.js", "nodejs", "node js"], related: ["Express", "NestJS", "Deno"], category: "backend" },
  { canonical: "Express", aliases: ["express", "express.js", "expressjs"], related: ["Node.js", "NestJS", "Fastify"], category: "backend" },
  { canonical: "NestJS", aliases: ["nestjs", "nest.js"], related: ["Node.js", "Express"], category: "backend" },
  { canonical: "Fastify", aliases: ["fastify"], related: ["Express", "Node.js"], category: "backend" },
  { canonical: "Deno", aliases: ["deno"], related: ["Node.js"], category: "backend" },
  { canonical: "Django", aliases: ["django"], related: ["Python", "FastAPI"], category: "backend" },
  { canonical: "FastAPI", aliases: ["fastapi"], related: ["Python", "Django"], category: "backend" },
  { canonical: "Spring Boot", aliases: ["spring", "spring boot"], related: ["Java"], category: "backend" },
  { canonical: "Microservices", aliases: ["microservices", "micro-services", "microservice architecture"], related: [], category: "backend" },
  { canonical: "PostgreSQL", aliases: ["postgres", "postgresql", "psql"], related: ["SQL", "MySQL"], category: "data" },
  { canonical: "MySQL", aliases: ["mysql", "mariadb"], related: ["SQL", "PostgreSQL"], category: "data" },
  { canonical: "MongoDB", aliases: ["mongodb", "mongo", "mongoose"], related: [], category: "data" },
  { canonical: "Redis", aliases: ["redis"], related: [], category: "data" },
  { canonical: "Kafka", aliases: ["kafka", "apache kafka"], related: ["RabbitMQ"], category: "data" },
  { canonical: "RabbitMQ", aliases: ["rabbitmq"], related: ["Kafka"], category: "data" },
  { canonical: "Prisma", aliases: ["prisma", "prisma orm"], related: ["PostgreSQL"], category: "data" },

  // Cloud / DevOps
  { canonical: "AWS", aliases: ["aws", "amazon web services"], related: ["GCP", "Azure", "Amazon S3"], category: "cloud" },
  { canonical: "Amazon S3", aliases: ["s3", "aws s3", "amazon s3"], related: ["AWS", "Chunked uploads"], category: "cloud" },
  { canonical: "AWS Lambda", aliases: ["lambda", "aws lambda", "serverless"], related: ["AWS"], category: "cloud" },
  { canonical: "GCP", aliases: ["gcp", "google cloud", "google cloud platform"], related: ["AWS", "Azure"], category: "cloud" },
  { canonical: "Azure", aliases: ["azure", "microsoft azure"], related: ["AWS", "GCP"], category: "cloud" },
  { canonical: "Docker", aliases: ["docker", "containers", "containerization"], related: ["Kubernetes"], category: "devops" },
  { canonical: "Kubernetes", aliases: ["kubernetes", "k8s"], related: ["Docker"], category: "devops" },
  { canonical: "CI/CD", aliases: ["ci/cd", "ci cd", "github actions", "jenkins", "gitlab ci", "continuous integration"], related: [], category: "devops" },
  { canonical: "Git", aliases: ["git", "github", "gitlab", "bitbucket"], related: [], category: "tooling" },

  // Testing
  { canonical: "Jest", aliases: ["jest"], related: ["Vitest", "Unit testing"], category: "testing" },
  { canonical: "Vitest", aliases: ["vitest"], related: ["Jest", "Unit testing"], category: "testing" },
  { canonical: "React Testing Library", aliases: ["react testing library", "testing library", "rtl"], related: ["Jest"], category: "testing" },
  { canonical: "Playwright", aliases: ["playwright"], related: ["Cypress", "End-to-end testing"], category: "testing" },
  { canonical: "Cypress", aliases: ["cypress"], related: ["Playwright", "End-to-end testing"], category: "testing" },
  { canonical: "Unit testing", aliases: ["unit testing", "unit tests", "tdd", "test-driven development"], related: ["Jest", "Vitest"], category: "testing" },
  { canonical: "End-to-end testing", aliases: ["e2e", "e2e testing", "end-to-end testing", "end to end testing"], related: ["Playwright", "Cypress"], category: "testing" },

  // Mobile
  { canonical: "React Native", aliases: ["react native", "react-native"], related: ["React", "Flutter"], category: "mobile" },
  { canonical: "Flutter", aliases: ["flutter", "dart"], related: ["React Native"], category: "mobile" },
  { canonical: "Electron", aliases: ["electron", "electron.js"], related: ["Tauri"], category: "frontend" },
  { canonical: "Tauri", aliases: ["tauri"], related: ["Electron"], category: "frontend" },

  // Design & product
  { canonical: "Figma", aliases: ["figma"], related: ["Design systems"], category: "design" },
  { canonical: "Agile", aliases: ["agile", "scrum", "kanban"], related: [], category: "concept" },
  { canonical: "System design", aliases: ["system design", "distributed systems", "scalable systems"], related: ["Microservices"], category: "concept" },
  { canonical: "Machine learning", aliases: ["machine learning", "ml", "deep learning"], related: ["LLM integration"], category: "data" },
  { canonical: "LLM integration", aliases: ["llm", "llms", "genai", "generative ai", "openai api", "anthropic api", "prompt engineering"], related: ["Machine learning"], category: "concept" },
];

interface AliasIndexEntry {
  alias: string;
  canonical: string;
  pattern: RegExp;
}

const skillsByCanonical = new Map<string, SkillDefinition>();
const aliasToCanonical = new Map<string, string>();
let aliasIndex: AliasIndexEntry[] = [];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPattern(alias: string): RegExp {
  // Boundaries: an alias must not be glued to letters/digits, and a bare alias must
  // not be the tail of a dotted name (so "js" does not match inside "node.js").
  const body = escapeRegExp(alias).replace(/\\ /g, "[\\s-]+").replace(/ /g, "[\\s-]+");
  return new RegExp(`(?<![a-z0-9.#+])${body}(?![a-z0-9#+]|\\.[a-z])`, "gi");
}

function rebuildIndex(): void {
  const entries: AliasIndexEntry[] = [];
  for (const [alias, canonical] of aliasToCanonical) {
    // Very short, ambiguous aliases are only used for exact normalisation, not free-text search.
    if (AMBIGUOUS_FREE_TEXT_ALIASES.has(alias)) continue;
    entries.push({ alias, canonical, pattern: buildPattern(alias) });
  }
  // Longest aliases first so "react native" wins over "react".
  entries.sort((a, b) => b.alias.length - a.alias.length);
  aliasIndex = entries;
}

/** Aliases too ambiguous to detect inside prose (still valid for explicit skill lists). */
const AMBIGUOUS_FREE_TEXT_ALIASES = new Set(["go", "ts", "rtl", "ml", "mse", "less", "rest", "node", "lambda", "spring", "express", "containers", "real-time", "relay", "hls"]);

function registerDefinition(def: SkillDefinition): void {
  const existing = skillsByCanonical.get(def.canonical);
  if (existing) {
    existing.aliases = Array.from(new Set([...existing.aliases, ...def.aliases]));
    existing.related = Array.from(new Set([...existing.related, ...def.related]));
  } else {
    skillsByCanonical.set(def.canonical, { ...def, aliases: [...def.aliases], related: [...def.related] });
  }
  aliasToCanonical.set(normalizeKey(def.canonical), def.canonical);
  for (const alias of def.aliases) aliasToCanonical.set(normalizeKey(alias), def.canonical);
}

for (const def of BASE_SKILLS) registerDefinition(def);
rebuildIndex();

/**
 * Admin-extensible aliases. Unknown canonical names become new skills.
 * Returns the number of aliases registered.
 */
export function registerSkillAliases(
  entries: { alias: string; canonical: string; related?: string[] }[],
): number {
  let count = 0;
  for (const entry of entries) {
    const alias = normalizeKey(entry.alias);
    const canonical = entry.canonical.trim();
    if (!alias || !canonical) continue;
    registerDefinition({
      canonical,
      aliases: [alias],
      related: entry.related ?? [],
      category: skillsByCanonical.get(canonical)?.category ?? "concept",
    });
    count += 1;
  }
  rebuildIndex();
  return count;
}

/**
 * Normalise a skill name to its canonical form. Unknown skills are returned
 * trimmed with their original casing so they can still be compared exactly.
 */
export function normalizeSkill(name: string): string {
  const key = normalizeKey(name);
  const direct = aliasToCanonical.get(key);
  if (direct) return direct;
  // Tolerate trailing punctuation / version numbers: "React 18", "TypeScript 5.x"
  const stripped = key.replace(/\s*v?\d+(\.\d+|\.x)*\+?$/, "").replace(/[.,;:]+$/, "");
  return aliasToCanonical.get(stripped) ?? name.trim().replace(/\s+/g, " ");
}

export function isKnownSkill(name: string): boolean {
  return skillsByCanonical.has(normalizeSkill(name));
}

export function getSkillDefinition(name: string): SkillDefinition | undefined {
  return skillsByCanonical.get(normalizeSkill(name));
}

/** Related skills (symmetric) - related is NOT equal and earns partial credit only. */
export function getRelatedSkills(name: string): string[] {
  const canonical = normalizeSkill(name);
  const related = new Set(skillsByCanonical.get(canonical)?.related ?? []);
  for (const def of skillsByCanonical.values()) {
    if (def.related.includes(canonical)) related.add(def.canonical);
  }
  related.delete(canonical);
  return [...related];
}

export function areRelatedSkills(a: string, b: string): boolean {
  const ca = normalizeSkill(a);
  const cb = normalizeSkill(b);
  if (ca === cb) return false;
  return getRelatedSkills(ca).includes(cb);
}

export interface SkillMention {
  skill: string;
  start: number;
  end: number;
}

/** Skill mentions with character spans (longest alias first, non-overlapping), in text order. */
export function findSkillMentions(text: string): SkillMention[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const mentions: SkillMention[] = [];
  for (const entry of aliasIndex) {
    entry.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entry.pattern.exec(lower)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (mentions.some((x) => start < x.end && end > x.start)) continue;
      mentions.push({ skill: entry.canonical, start, end });
    }
  }
  return mentions.sort((a, b) => a.start - b.start);
}

/** Detect canonical skills mentioned in free text, longest alias first, non-overlapping. */
export function extractSkillsFromText(text: string): string[] {
  return [...new Set(findSkillMentions(text).map((m) => m.skill))];
}

export function listCanonicalSkills(): string[] {
  return [...skillsByCanonical.keys()].sort((a, b) => a.localeCompare(b));
}

/** Domain vocabulary used for "domain relevance" scoring. */
export const DOMAIN_KEYWORDS: Record<string, string[]> = {
  "video & media": ["video", "media", "streaming", "ott", "creator", "podcast", "audio", "editing", "editor", "transcod", "timeline", "animation"],
  "creator tools": ["creator", "creators", "influencer", "content creation", "design tool", "editor"],
  saas: ["saas", "b2b", "workflow", "workflows", "dashboard", "subscription", "multi-tenant"],
  fintech: ["fintech", "payments", "banking", "lending", "upi", "trading", "insurance"],
  "e-commerce": ["e-commerce", "ecommerce", "retail", "marketplace", "checkout", "d2c"],
  edtech: ["edtech", "learning", "education", "students", "courses"],
  healthtech: ["healthtech", "health", "clinical", "patients", "hospital"],
  "developer tools": ["developer tools", "devtools", "developer experience", "sdk", "ide", "api platform"],
  gaming: ["gaming", "game", "games"],
  logistics: ["logistics", "supply chain", "delivery", "fleet"],
  "collaboration": ["collaboration", "real-time collaboration", "whiteboard", "co-editing"],
};

export function detectDomains(text: string): string[] {
  const lower = (text || "").toLowerCase();
  const domains: string[] = [];
  for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
    if (words.some((w) => new RegExp(`(?<![a-z])${escapeRegExp(w)}`, "i").test(lower))) {
      domains.push(domain);
    }
  }
  return domains;
}

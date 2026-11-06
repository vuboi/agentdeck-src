// Bundle app icon keys with Phosphor Bold SVGs so the packaged app stays offline.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const src = 'apps/desktop/src';
const names = new Set();
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(svelte|ts)$/.test(entry) && !path.endsWith('bundled-icons.ts')) {
      for (const match of readFileSync(path, 'utf8').matchAll(/\b(?:lucide|phosphor)[A-Z][A-Za-z0-9]*/g)) names.add(match[0]);
    }
  }
};
walk(src);

const ALIASES = {
  lucideActivity: 'pulse', lucideArrowDownToLine: 'arrow-line-down', lucideArrowLeftRight: 'arrows-left-right',
  lucideArrowRightLeft: 'arrows-left-right', lucideArrowUpDown: 'arrows-down-up', lucideArrowUpFromLine: 'arrow-line-up',
  lucideAtSign: 'at', lucideAudioLines: 'waveform', lucideBan: 'prohibit', lucideBot: 'robot', lucideBraces: 'brackets-curly',
  lucideChevronDown: 'caret-down', lucideChevronLeft: 'caret-left', lucideChevronRight: 'caret-right', lucideChevronUp: 'caret-up',
  lucideChevronsDownUp: 'caret-circle-double-down', lucideChevronsUpDown: 'caret-circle-double-up', lucideCircleAlert: 'warning-circle',
  lucideCircleCheck: 'check-circle', lucideCircleDot: 'dot-outline', lucideCircleOff: 'circle-dashed', lucideCirclePause: 'pause-circle',
  lucideCircleX: 'x-circle', lucideClipboardList: 'clipboard-text', lucideClipboardPaste: 'clipboard-text', lucideClock3: 'clock',
  lucideCloudUpload: 'cloud-arrow-up', lucideColumns3: 'columns', lucideCopyPlus: 'copy', lucideDatabaseZap: 'database',
  lucideEllipsis: 'dots-three', lucideEllipsisVertical: 'dots-three-vertical', lucideExternalLink: 'arrow-square-out', lucideCornerDownLeft: 'arrow-u-down-left',
  lucideFileJson: 'file-code', lucideFilePen: 'note-pencil', lucideFileQuestion: 'file', lucideFilm: 'film-strip', lucideFilter: 'funnel', lucideFlaskConical: 'flask',
  lucideFolderClosed: 'folder', lucideFolderSync: 'folder-simple', lucideGitBranchPlus: 'git-branch', lucideGitCompare: 'git-diff',
  lucideGithub: 'github-logo', lucideGrid2x2Check: 'squares-four', lucideGrid2x2Plus: 'squares-four', lucideGripVertical: 'dots-six-vertical',
  lucideHistory: 'clock-counter-clockwise', lucideImagePlus: 'image-square', lucideInbox: 'tray', lucideKeyRound: 'key', lucideLayers: 'stack',
  lucideLayoutGrid: 'squares-four', lucideLayoutList: 'list', lucideLibrary: 'books', lucideListOrdered: 'list-numbers', lucideListX: 'list-dashes',
  lucideLoaderCircle: 'circle-notch', lucideLogIn: 'sign-in', lucideMaximize2: 'arrows-out', lucideMenu: 'list', lucideMessageCircle: 'chat-circle',
  lucideMessageCircleQuestion: 'question', lucideMessageSquare: 'chat-text', lucideMessageSquareMore: 'chat-text', lucideMessageSquareOff: 'chat-slash',
  lucideMessageSquarePlus: 'chat-circle', lucideMessageSquareText: 'chat-text', lucideMessagesSquare: 'chats', lucideMinimize2: 'arrows-in',
  lucideMousePointer2: 'cursor', lucideMousePointerClick: 'cursor-click', lucideMoveUpRight: 'arrow-up-right', lucidePanelLeft: 'sidebar-simple',
  lucidePanelRight: 'sidebar-simple', lucidePanelRightClose: 'sidebar-simple', lucidePanelRightOpen: 'sidebar-simple', lucidePanelsTopLeft: 'layout',
  lucidePenLine: 'pen', lucidePin: 'push-pin', lucidePinOff: 'push-pin-slash', lucidePuzzle: 'puzzle-piece', lucideRedo2: 'arrow-counter-clockwise',
  lucideRefreshCw: 'arrows-clockwise', lucideRotateCcw: 'arrow-counter-clockwise', lucideRotateCw: 'arrow-clockwise', lucideRoute: 'path',
  lucideRows3: 'rows', lucideSave: 'floppy-disk', lucideScanText: 'scan', lucideScrollText: 'scroll', lucideSearch: 'magnifying-glass',
  lucideSearchX: 'magnifying-glass', lucideSend: 'paper-plane-tilt', lucideServer: 'hard-drives', lucideServerOff: 'hard-drives',
  lucideSettings: 'gear', lucideSettings2: 'gear-six', lucideShare2: 'share-network', lucideShieldAlert: 'shield-warning', lucideShieldX: 'shield-slash',
  lucideShrink: 'arrows-in', lucideSmartphone: 'device-mobile', lucideSparkles: 'sparkle', lucideSplit: 'split-horizontal', lucideSquareArrowUpRight: 'arrow-square-out',
  lucideSquarePause: 'pause', lucideSquarePen: 'note-pencil', lucideSquareTerminal: 'terminal-window', lucideTable2: 'table', lucideTablet: 'device-tablet',
  lucideTextCursorInput: 'text-t', lucideTextSelect: 'text-aa', lucideTrash2: 'trash', lucideTriangleAlert: 'warning', lucideType: 'text-t',
  lucideUndo2: 'arrow-u-down-left', lucideUnplug: 'plugs-connected', lucideUsersRound: 'users-three', lucideWorkflow: 'flow-arrow',
  lucideWrapText: 'text-align-left', lucideWandSparkles: 'magic-wand', lucideMusic: 'music-note', lucideZap: 'lightning',
};

const require = createRequire(join(process.cwd(), 'apps/desktop/package.json'));
const coreRoot = join(dirname(require.resolve('@phosphor-icons/core')), '..');
const available = new Set(readdirSync(join(coreRoot, 'assets/bold')).map((name) => name.replace(/-bold\.svg$/, '')));
const toKebab = (name) => name.replace(/^lucide/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').replace(/(\d+)/g, '-$1').toLowerCase();
const assetFor = (name) => {
  const asset = name.startsWith('phosphor')
    ? toKebab(name.replace(/^phosphor/, '').replace(/(Bold|Fill|Light|Thin|Duotone)$/, ''))
    : ALIASES[name] ?? toKebab(name);
  if (available.has(asset)) return asset;
  console.warn(`Phosphor icon missing for ${name}: ${asset}; using question`);
  return 'question';
};

const found = [...names].sort();
const lines = [
  '// Generated by scripts/gen-icons.mjs: app icon keys backed by Phosphor Bold SVGs.',
  "import { zProvideIcons } from '@shival99/z-ui-svelte';",
  ...found.map((name, index) => `import icon${index} from '@phosphor-icons/core/assets/bold/${assetFor(name)}-bold.svg?raw';`),
  '',
  'zProvideIcons({',
  ...found.map((name, index) => `  ${name}: icon${index},`),
  '});',
  '',
];
writeFileSync(join(src, 'lib/app/platform/bundled-icons.ts'), lines.join('\n'));
console.log(`${found.length} icon keys bundled from Phosphor Bold`);

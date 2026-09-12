/* The wordmarks.
 *
 * One drawing of the name is a logo; sixteen of them, one picked at random on
 * every visit, is a little more fun to come back to — which for a practice tool
 * is worth something. They are ASCII art of the kind a figlet font produces,
 * kept as data rather than as markup so the picker on the landing screen and
 * the tests can both enumerate them.
 *
 * Every row of a drawing is padded to the same width. That makes each one a
 * true rectangle, so `cols` is exactly as wide as it looks — which is what the
 * CSS sizes against — and a row truncated in an edit shows up as a broken
 * invariant rather than as a letter quietly out of place.
 *
 * They vary from 20 to 68 columns and from 4 to 11 rows, which is why nothing
 * here assumes a size. See `.landing .wordmark .art` in base.css: the font size
 * is derived from `cols` so a wide drawing and a narrow one land at about the
 * same width on screen.
 */

export interface WordmarkArt {
  /** Stable across releases: it is what a saved preference stores. */
  readonly id: string;
  /** What the picker calls it. */
  readonly name: string;
  /** Equal-width rows, top to bottom. */
  readonly rows: readonly string[];
}

export const WORDMARKS: readonly WordmarkArt[] = [
  {
    id: "slant-relief",
    name: "Slant relief",
    rows: [
      "________/\\\\\\\\\\\\\\\\\\__/\\\\\\______________/\\\\\\__/\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\_        ",
      " _____/\\\\\\////////__\\/\\\\\\_____________\\/\\\\\\_\\///////\\\\\\/////__       ",
      "  ___/\\\\\\/___________\\/\\\\\\_____________\\/\\\\\\_______\\/\\\\\\_______      ",
      "   __/\\\\\\_____________\\//\\\\\\____/\\\\\\____/\\\\\\________\\/\\\\\\_______     ",
      "    _\\/\\\\\\______________\\//\\\\\\__/\\\\\\\\\\__/\\\\\\_________\\/\\\\\\_______    ",
      "     _\\//\\\\\\______________\\//\\\\\\/\\\\\\/\\\\\\/\\\\\\__________\\/\\\\\\_______   ",
      "      __\\///\\\\\\_____________\\//\\\\\\\\\\\\//\\\\\\\\\\___________\\/\\\\\\_______  ",
      "       ____\\////\\\\\\\\\\\\\\\\\\_____\\//\\\\\\__\\//\\\\\\____________\\/\\\\\\_______ ",
      "        _______\\/////////_______\\///____\\///_____________\\///________",
    ],
  },
  {
    id: "shadow-block",
    name: "Shadow block",
    rows: [
      " ██████╗██╗    ██╗████████╗",
      "██╔════╝██║    ██║╚══██╔══╝",
      "██║     ██║ █╗ ██║   ██║   ",
      "██║     ██║███╗██║   ██║   ",
      "╚██████╗╚███╔███╔╝   ██║   ",
      " ╚═════╝ ╚══╝╚══╝    ╚═╝   ",
    ],
  },
  {
    id: "shaded-slab",
    name: "Shaded slab",
    rows: [
      "   █████████  █████   ███   █████ ███████████",
      "  ███░░░░░███░░███   ░███  ░░███ ░█░░░███░░░█",
      " ███     ░░░  ░███   ░███   ░███ ░   ░███  ░ ",
      "░███          ░███   ░███   ░███     ░███    ",
      "░███          ░░███  █████  ███      ░███    ",
      "░░███     ███  ░░░█████░█████░       ░███    ",
      " ░░█████████     ░░███ ░░███         █████   ",
      "  ░░░░░░░░░       ░░░   ░░░         ░░░░░    ",
    ],
  },
  {
    id: "stencil",
    name: "Stencil",
    rows: [
      "====================================",
      "===     ===  ====  ====  ==        =",
      "==  ===  ==  ====  ====  =====  ====",
      "=  ========  ====  ====  =====  ====",
      "=  ========  ====  ====  =====  ====",
      "=  ========   ==    ==  ======  ====",
      "=  =========  ==    ==  ======  ====",
      "=  =========  ==    ==  ======  ====",
      "==  ===  ====    ==    =======  ====",
      "===     ======  ====  ========  ====",
      "====================================",
    ],
  },
  {
    id: "cursive",
    name: "Cursive",
    rows: [
      "   )\\.-.       .'(  .-,.-.,-.",
      " ,' ,-,_)  ,') \\  ) ) ,, ,. (",
      "(  .   _  (  /(/ /  \\( |(  )/",
      " ) '..' )  )    (      ) \\   ",
      "(  ,   (  (  .'\\ \\     \\ (   ",
      " )/'._.'   )/   )/      )/   ",
    ],
  },
  {
    id: "contour",
    name: "Contour",
    rows: [
      "  ___  _    _  ____ ",
      " / __)( \\/\\/ )(_  _)",
      "( (__  )    (   )(  ",
      " \\___)(__/\\__) (__) ",
    ],
  },
  {
    id: "pipe",
    name: "Pipe",
    rows: [
      " _______          _________",
      "(  ____ \\|\\     /|\\__   __/",
      "| (    \\/| )   ( |   ) (   ",
      "| |      | | _ | |   | |   ",
      "| |      | |( )| |   | |   ",
      "| |      | || || |   | |   ",
      "| (____/\\| () () |   | |   ",
      "(_______/(_______)   )_(   ",
    ],
  },
  {
    id: "rounded-pipe",
    name: "Rounded pipe",
    rows: [
      " _______  _     _  _______ ",
      "|       || | _ | ||       |",
      "|       || || || ||_     _|",
      "|       ||       |  |   |  ",
      "|      _||       |  |   |  ",
      "|     |_ |   _   |  |   |  ",
      "|_______||__| |__|  |___|  ",
    ],
  },
  {
    id: "brush",
    name: "Brush",
    rows: [
      "  ___| \\ \\        / __ __|",
      " |      \\ \\  \\   /     |  ",
      " |       \\ \\  \\ /      |  ",
      "\\____|    \\_/\\_/      _|  ",
    ],
  },
  {
    id: "speed",
    name: "Speed",
    rows: [
      "___________       _________",
      "__  ____/_ |     / /__  __/",
      "_  /    __ | /| / /__  /   ",
      "/ /___  __ |/ |/ / _  /    ",
      "\\____/  ____/|__/  /_/     ",
    ],
  },
  {
    id: "nameplate",
    name: "Nameplate",
    rows: [
      "   ___  __      _______ ",
      "  / __| \\ \\    / /_   _|",
      " | (__   \\ \\/\\/ /  | |  ",
      "  \\___|   \\_/\\_/  _|_|_ ",
      "_|\"\"\"\"\"|_|\"\"\"\"\"|_|\"\"\"\"\"|",
      "\"`-0-0-'\"`-0-0-'\"`-0-0-'",
    ],
  },
  {
    id: "hatch",
    name: "Hatch",
    rows: [
      "      ::::::::  :::       ::: :::::::::::",
      "    :+:    :+: :+:       :+:     :+:     ",
      "   +:+        +:+       +:+     +:+      ",
      "  +#+        +#+  +:+  +#+     +#+       ",
      " +#+        +#+ +#+#+ +#+     +#+        ",
      "#+#    #+#  #+#+# #+#+#      #+#         ",
      "########    ###   ###       ###          ",
    ],
  },
  {
    id: "filigree",
    name: "Filigree",
    rows: [
      "    ,o888888o.  `8.`888b                 ,8' 8888888 8888888888",
      "   8888     `88. `8.`888b               ,8'        8 8888      ",
      ",8 8888       `8. `8.`888b             ,8'         8 8888      ",
      "88 8888            `8.`888b     .b    ,8'          8 8888      ",
      "88 8888             `8.`888b    88b  ,8'           8 8888      ",
      "88 8888              `8.`888b .`888b,8'            8 8888      ",
      "88 8888               `8.`888b8.`8888'             8 8888      ",
      "`8 8888       .8'      `8.`888`8.`88'              8 8888      ",
      "   8888     ,88'        `8.`8' `8,`'               8 8888      ",
      "    `8888888P'           `8.`   `8'                8 8888      ",
    ],
  },
  {
    id: "eights",
    name: "Eights",
    rows: [
      " .d8888b.  888       888 88888888888",
      "d88P  Y88b 888   o   888     888    ",
      "888    888 888  d8b  888     888    ",
      "888        888 d888b 888     888    ",
      "888        888d88888b888     888    ",
      "888    888 88888P Y88888     888    ",
      "Y88b  d88P 8888P   Y8888     888    ",
      " \"Y8888P\"  888P     Y888     888    ",
    ],
  },
  {
    id: "mini-block",
    name: "Mini block",
    rows: [
      "8\"\"\"\"8 8   8  8 \"\"8\"\"",
      "8    \" 8   8  8   8  ",
      "8e     8e  8  8   8e ",
      "88     88  8  8   88 ",
      "88   e 88  8  8   88 ",
      "88eee8 88ee8ee8   88 ",
    ],
  },
  {
    id: "curl",
    name: "Curl",
    rows: [
      "  e88'Y88 Y8b Y8b Y888P 88P'888'Y88",
      " d888  'Y  Y8b Y8b Y8P  P'  888  'Y",
      "C8888       Y8b Y8b Y       888    ",
      " Y888  ,d    Y8b Y8b        888    ",
      "  \"88,d88     Y8P Y         888    ",
    ],
  },
];

/** How many characters wide the drawing is. Every row is the same, so the
 *  first one answers for all of them — and the tests hold that to be true. */
export function wordmarkCols(art: WordmarkArt): number {
  return art.rows[0]?.length ?? 0;
}

export function wordmarkText(art: WordmarkArt): string {
  return art.rows.join("\n");
}

export function wordmarkById(id: string | undefined): WordmarkArt | null {
  if (!id) return null;
  return WORDMARKS.find((w) => w.id === id) ?? null;
}

/** One at random. `random` is injectable so a test can pin the choice. */
export function pickWordmark(random: () => number = Math.random): WordmarkArt {
  const i = Math.min(WORDMARKS.length - 1, Math.floor(random() * WORDMARKS.length));
  return WORDMARKS[i]!;
}

/* This visit's drawing.
 *
 * Rolled once per page load and then held, rather than once per component
 * mount: the landing screen and the review header both draw the name, and they
 * are never on screen at the same time — so a roll per mount would mean the
 * logo silently changed the moment you finished a recording. One visit, one
 * drawing.
 *
 * Held in a module variable rather than in React state for the same reason: it
 * has to outlive the screen that first asked for it. It never changes within a
 * visit, so reading it during a render is stable. */
let visitRoll: WordmarkArt | null = null;

export function visitWordmark(): WordmarkArt {
  visitRoll ??= pickWordmark();
  return visitRoll;
}

/** Forget the roll. For tests, which are many "visits" in one process. */
export function resetVisitRoll(): void {
  visitRoll = null;
}

/* How much vertical room to hold open for whichever drawing turns up.
 *
 * They are 4 to 11 rows tall and the hero is sized to fill the page width, so
 * the rendered height swings from about 120px to about 330px depending on the
 * roll. Without a reserve, reloading the page makes everything below the
 * wordmark jump — which is a strange thing for a random logo to do to the rest
 * of the layout.
 *
 * So this is the height of the tallest one, as a CSS expression rather than a
 * measured number: the size the CSS gives a drawing is
 * `rows * clamp(4px, W / cols / 0.6, cap)`, and the tallest is whichever of the
 * sixteen wins that at the current width. Which one that is changes with the
 * viewport — the cap binds for the narrow drawings and not for the wide ones —
 * so the answer is a max() over all of them rather than a single winner picked
 * here. Generated from the catalog, so adding a drawing cannot leave it stale.
 *
 * `--wm-w` and `--wm-max` are the same custom properties the sizing rule
 * reads, which is what keeps the two in step. */
export const HERO_RESERVE: string = `max(${WORDMARKS.map((art) => {
  const rows = art.rows.length;
  return (
    `min(calc(var(--wm-w) * ${rows} / ${wordmarkCols(art)} / 0.6), ` +
    `calc(var(--wm-max) * ${rows}))`
  );
}).join(", ")})`;

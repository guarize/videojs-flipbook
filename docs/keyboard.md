# Keyboard and gestures

The same list is in the player on the shortcuts card (<kbd>?</kbd>), which shows only the rows that can work. A key that belongs to an extra that is off is not listed there and does nothing. This page is written from `src/skins/flipbook/keymap.ts`.

Letter, number and symbol keys reach the player only while it has focus or the pointer is over it. Typed anywhere else on the page they do nothing (WCAG 2.1.4). <kbd>Space</kbd>, the arrows, <kbd>Home</kbd>, <kbd>End</kbd>, <kbd>Page Up</kbd> and <kbd>Page Down</kbd> still work from the page.

## Keys

| Key | Does | Needs |
|---|---|---|
| <kbd>Space</kbd> or <kbd>K</kbd> | Play or pause | |
| <kbd>J</kbd> <kbd>L</kbd> | Back or forward 10 s | |
| <kbd>←</kbd> <kbd>→</kbd> | Back or forward 5 s | |
| <kbd>←</kbd> <kbd>→</kbd>, held | Riffle the pages | `deck` |
| <kbd>←</kbd> <kbd>→</kbd>, paused | One page back or on | `deck` |
| <kbd>,</kbd> <kbd>.</kbd>, paused | One frame back or on | `deck` |
| <kbd>Page Up</kbd> <kbd>Page Down</kbd> | Previous or next chapter | |
| <kbd>↑</kbd> <kbd>↓</kbd> | Volume | |
| <kbd>M</kbd> | Mute | |
| <kbd>0</kbd> to <kbd>9</kbd> | Go to 0–90 % | |
| <kbd>&lt;</kbd> <kbd>&gt;</kbd> | Slower or faster | |
| <kbd>C</kbd> | Captions | |
| <kbd>Shift</kbd> <kbd>C</kbd> | Caption style | |
| <kbd>F</kbd> | Full screen | |
| <kbd>I</kbd> | Picture in picture | |
| <kbd>T</kbd> | Contents | `contents` |
| <kbd>B</kbd> | Bookmark this moment | `ribbons` |
| <kbd>[</kbd> <kbd>]</kbd> | Previous or next bookmark | `ribbons` |
| <kbd>N</kbd> | Next chapter | |
| <kbd>P</kbd> | Paused, the twelve frames around the moment, large | `plate` |
| <kbd>S</kbd> | Keep this page as a picture | `tear` |
| <kbd>?</kbd> | The shortcuts card | |
| <kbd>Esc</kbd> | Close a menu, a panel or the plate, and return focus to the key that opened it | |

<kbd>I</kbd> follows what the browser has. With a Document Picture-in-Picture window (Chrome, Edge, and the Firefox 157 the browser tests ran in), the whole book goes into that window. In Safari it opens Safari's own video window. In a browser with neither, the key does nothing and its row is not shown.

## On the paused page

| Where focus is | Key | Does |
|---|---|---|
| The strip of frames (one Tab stop) | <kbd>←</kbd> <kbd>→</kbd> | Along the frames |
| | <kbd>Home</kbd> <kbd>End</kbd> | Its first and last frame |
| | <kbd>Enter</kbd> or <kbd>Space</kbd> | Go to that frame |
| The plate's grid (one Tab stop) | <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd>, <kbd>Home</kbd>, <kbd>End</kbd>, <kbd>Enter</kbd> | The same, in four columns |

Each frame of the strip is named "Frame 4 of 12, 0:19.5", and the one you are on is `aria-current`.

## Gestures

| Gesture | Does | Needs |
|---|---|---|
| Drag the edge, then away from it | Finer control | |
| Flick the edge | Throw the pages | `deck` |
| Scroll on the edge | Riffle the pages | `deck` |
| Swipe the picture | Right flips on, left flips back | `deck` |
| Paused, choose a frame in the strip under the picture | Go there | `plate` |
| Double-tap left or right | 10 s back or forward | |
| Paused, pull the corner | Next chapter | `curl` |
| Fold the top-left corner | Bookmark | `ear` |
| Pull the paused page out | Keep it as a picture | `tear` |
| Click the time | Type one | |

## Tab order

Tab order follows the screen. Walking the player with <kbd>Tab</kbd> reaches 15 stops, and every stop shows a focus ring in both browsers (`tests/e2e/keyboard.spec.ts`). WebKit is walked with <kbd>Option</kbd> <kbd>Tab</kbd>, as a keyboard user on a Mac presses it. The chapter tabs, the ribbons and the plate's frames are one stop each, with the arrow keys inside.

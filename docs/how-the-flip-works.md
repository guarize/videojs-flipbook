# How the flip works

In a flipbook the hand makes the motion. Here it does too. This page is a short reading of `src/skins/flipbook/flip.ts`, whose opening comment has the full state machine.

## The hand has the film

Run a pointer, a finger or the wheel along the fore-edge and the film itself moves in the picture at the speed of the hand, forwards and backwards. Nothing is simulated on top of the video. The frames you see are the film's own.

While a hand drives, the film is paused and chased with exact seeks. One seek is in flight at a time, and the next is asked for the moment the last has landed. Asking on every pointer move starves the decoder, which gives fewer frames and gaps of a third of a second.

## When the film is a stream

A film beside the page seeks at once, and the hand can chase it directly. A stream cannot keep up. It has a keyframe every few seconds, and a paused seek on it takes 0.3 to 2.5 seconds (`stand.ts`). So something stands in for the picture while the hand moves, and `standing.ts` picks the best there is.

| The page gives | The hand flips | What you see |
|---|---|---|
| A file as `src` | The film itself | The film's own frames |
| A stream and a `scrub` copy | The copy, a silent file with a keyframe every second | Exact frames. The stream takes the picture back on the frame where the hand rests. |
| A stream and no copy | The storyboard's pages, drawn at the picture's size | The page's still, counted as a page ("p. 26"). The stream's own frame follows. |

The stand-in lies over the picture in the picture's own box. It leaves only when the film shows that frame itself, by the browser's own word and never on a timer (`shown.ts`).

## Letting go

Let go with the hand still and the film rests there. It plays on if it was playing before the press, and stays paused if it was paused.

Let go with the hand still moving and that is a flick. The pages keep going at the hand's speed, never more than 4×, and ease down to the viewer's own rate. Going forwards this is real playback from the first frame, with `playbackRate` falling to exactly that rate. Backwards, or faster than 4×, the film is chased with seeks until it has slowed into that range.

A click on the edge is not a drag. The film goes to that place and stays as it was, playing or paused. <kbd>Esc</kbd> during a drag puts the film back where the press began. If the pointer is lost (the window loses focus, the page is hidden, another button is pressed) the drag ends as if the hand had lifted, still.

## One owner at a time

The hover deck, the hand, the glide after a flick and the held arrow keys could each move the film. Only one of them has it at a time, and the mode is on the element as `fb-flip[data-mode]`. The hover deck is never an owner. It only shows a moment, and it is told when to stand down.

## Other ways in

- Holding <kbd>←</kbd> or <kbd>→</kbd> riffles the same way, faster the longer it is held.
- A mouse held and dragged along the fore-edge raises a small fan of pages beside the pointer, with the speed of the hand on a chip.
- A finger across the picture does what a thumb does on the edge, at a finer gear. The picture's width is sixteen seconds of film. Up and down stays the page's scroll, and nothing moves the film until a touch has gone sideways.
- Paused, the picture is a printed page and <kbd>←</kbd> and <kbd>→</kbd> turn exactly one.

## Without the book

All of this loads with the `deck` extra. Without it the fore-edge is Video.js's own seek slider, whose role, value text and keys the skin never changes.

## Where it is tested

`tests/e2e/flip.spec.ts` and `tests/e2e/edge-pointer.spec.ts` drive the edge with a real pointer and read the film's time, rate and paused state after each move. `tests/e2e/phone.spec.ts` does the same with touches.

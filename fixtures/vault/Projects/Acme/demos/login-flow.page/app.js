// Everything you change here lives in the page's state (state.json in this
// bundle), which Claude can read with `groundwork page state login-flow.page`:
//   { "reviewed": true, "timings": { "login": 150 } }
// Timings start from the CSV next to the bundle. Pages can read vault files
// but not write them, so edited timings are kept in the state instead.
const seen = document.getElementById("seen");
const list = document.getElementById("timings");
const reset = document.getElementById("reset");

const csv = await groundwork.readFile("../timings.csv");
const fromCsv = Object.fromEntries(
  csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(","))
    .map(([step, ms]) => [step, Number(ms)]),
);

let state = (await groundwork.state.get()) ?? {};

function save(next) {
  state = next;
  show();
  void groundwork.state.set(state);
}

function row(step) {
  const label = document.createElement("label");
  label.className = "timing";
  label.innerHTML = `<span class="step"></span><input type="number" min="0" /> ms <span class="was"></span>`;
  label.querySelector(".step").textContent = step;
  const input = label.querySelector("input");
  input.name = step;
  input.addEventListener("change", () => {
    const timings = { ...state.timings, [step]: Number(input.value) };
    if (timings[step] === fromCsv[step]) delete timings[step];
    const { timings: _, ...rest } = state;
    save(Object.keys(timings).length ? { ...state, timings } : rest);
  });
  list.append(label);
  return label;
}

function show() {
  seen.checked = state.reviewed === true;
  for (const [step, original] of Object.entries(fromCsv)) {
    const label = list.querySelector(`input[name="${step}"]`)?.closest("label") ?? row(step);
    const input = label.querySelector("input");
    const edited = state.timings?.[step];
    // Don't overwrite what you're typing.
    if (document.activeElement !== input) input.value = edited ?? original;
    label.querySelector(".was").textContent = edited === undefined ? "" : `(CSV: ${original})`;
  }
  reset.hidden = !state.timings;
}

seen.addEventListener("change", () => save({ ...state, reviewed: seen.checked }));
reset.addEventListener("click", () => {
  const { timings: _, ...rest } = state;
  save(rest);
});
// Claude (or the CLI) changed the state while the page was open.
groundwork.onStateChange((next) => {
  state = next ?? {};
  show();
});
show();

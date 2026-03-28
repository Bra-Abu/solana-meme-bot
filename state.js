// Shared mutable state — avoids circular dependencies
let _paused = false;

module.exports = {
  isPaused: () => _paused,
  setPaused: (val) => { _paused = val; },
};

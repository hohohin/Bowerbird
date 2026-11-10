const creation = () => ({ mode: 'clone', source: null, description: '', name: '', preview: 'idle', start: 0, end: 4 });
export const initial = () => ({ environment: { phase: 'missing', progress: 0 }, voices: [], selected: null, draft: '', jobs: [], creation: creation(), sequence: 0 });
export const activeJob = state => state.jobs.find(job => ['preparing', 'generating', 'saving'].includes(job.phase));
export const canPreview = state => state.environment.phase === 'ready' && (state.creation.mode === 'clone' ? !!state.creation.source : !!state.creation.description.trim());
export const canSave = state => state.creation.preview === 'ready' && !!state.creation.name.trim();
function editCreation(state, patch) { return { ...state, creation: { ...state.creation, ...patch } }; }
function install(state) {
  if (['ready', 'installing'].includes(state.environment.phase)) return state;
  return { ...state, environment: { ...state.environment, phase: 'installing' } };
}
function tick(state) {
  let next = state;
  if (state.environment.phase === 'installing') {
    const progress = Math.min(100, state.environment.progress + 20);
    next = { ...next, environment: { phase: progress === 100 ? 'ready' : 'installing', progress } };
  }
  if (next.creation.preview === 'loading') next = editCreation(next, { preview: 'ready' });
  const phases = { preparing: 'generating', generating: 'saving', saving: 'done' };
  return { ...next, jobs: next.jobs.map(job => phases[job.phase] ? { ...job, phase: phases[job.phase] } : job) };
}
function saveVoice(state) {
  if (!canSave(state)) return state;
  const id = `voice-${state.sequence + 1}`;
  const voice = { id, name: state.creation.name.trim(), kind: state.creation.mode, description: state.creation.description, source: state.creation.source };
  return { ...state, sequence: state.sequence + 1, selected: id, voices: [...state.voices, voice], creation: creation() };
}
function generate(state) {
  const voice = state.voices.find(voice => voice.id === state.selected);
  if (!voice || !state.draft.trim() || activeJob(state) || state.environment.phase !== 'ready') return state;
  return { ...state, sequence: state.sequence + 1, jobs: [{ id: `job-${state.sequence + 1}`, text: state.draft, voiceName: voice.name, phase: 'preparing', onCanvas: false }, ...state.jobs] };
}
function patchJob(state, id, patch) { return { ...state, jobs: state.jobs.map(job => job.id === id ? { ...job, ...patch } : job) }; }
function range(state, value) {
  if (!Number.isFinite(value.start) || !Number.isFinite(value.end)) return state;
  if (value.start < 0 || value.end - value.start < 1 || value.end - value.start > 30 || value.end > state.creation.source?.duration) return state;
  return editCreation(state, { ...value, preview: 'idle' });
}
const handlers = {
  install, tick, saveVoice, generate,
  ready: state => ({ ...state, environment: { phase: 'ready', progress: 100 } }),
  demo: () => ({ ...initial(), environment: { phase: 'ready', progress: 100 }, voices: [{ id: 'lin', name: '林岸', kind: 'clone', description: '沉稳 · 叙事', source: { name: '角色参考.wav', duration: 4 } }], selected: 'lin' }),
  installFailure: state => ({ ...state, environment: { ...state.environment, phase: 'failed' } }),
  pauseInstall: state => ({ ...state, environment: { ...state.environment, phase: 'paused' } }),
  unsupported: state => ({ ...state, environment: { phase: 'unsupported', progress: 0 } }),
  draft: (state, value) => ({ ...state, draft: value }),
  select: (state, value) => ({ ...state, selected: value }),
  mode: (state, value) => editCreation(state, { ...creation(), mode: value }),
  source: (state, value) => editCreation(state, { source: value, start: 0, end: Math.min(value.duration, 12), preview: 'idle' }),
  description: (state, value) => editCreation(state, { description: value, preview: 'idle' }),
  name: (state, value) => editCreation(state, { name: value }),
  range,
  preview: state => canPreview(state) ? editCreation(state, { preview: 'loading' }) : state,
  cancel: state => patchJob(state, activeJob(state)?.id, { phase: 'cancelled' }),
  saveFailure: state => patchJob(state, activeJob(state)?.id, { phase: 'saveFailed' }),
  retrySave: (state, value) => patchJob(state, value, { phase: 'done' }),
  canvas: (state, value) => patchJob(state, value, { onCanvas: true }),
  rename: (state, value) => ({ ...state, voices: state.voices.map(voice => voice.id === value.id ? { ...voice, name: value.name.trim() || voice.name } : voice) }),
  deleteVoice: (state, value) => { const voices = state.voices.filter(voice => voice.id !== value); return { ...state, voices, selected: state.selected === value ? voices[0]?.id ?? null : state.selected }; },
};
export function update(state, { type, value }) {
  if (!handlers[type]) throw new Error(`Unknown prototype event: ${type}`);
  return handlers[type](state, value);
}

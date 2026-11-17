// Device types, their tag prefixes, and the presets a fresh install starts with.

export const TYPES = [
  { id: 'breaker', label: 'Breaker', prefix: 'BKR', color: '#b3261e' },
  { id: 'fuse', label: 'Fuse', prefix: 'FUS', color: '#a85400' },
  { id: 'cable', label: 'Cable', prefix: 'CBL', color: '#1b6e3c' },
  { id: 'panel', label: 'Panel', prefix: 'PNL', color: '#1553b5' },
  { id: 'transformer', label: 'Transformer', prefix: 'XFMR', color: '#6a2fb0' },
  { id: 'other', label: 'Other', prefix: 'OTH', color: '#3f4753' },
];

export const typeOf = (id) => TYPES.find((t) => t.id === id) || TYPES[TYPES.length - 1];

export const DEFAULT_PRESETS = [
  ['breaker', 'Molded case', ['Manufacturer', 'Type / model', 'Frame (A)', 'Trip (A)', 'Trip unit', 'Settings', 'Interrupting (kA)', 'Voltage (V)']],
  ['breaker', 'LV power breaker', ['Manufacturer', 'Model', 'Frame (A)', 'Sensor / plug (A)', 'Trip unit', 'LTPU', 'LTD', 'STPU', 'STD', 'INST', 'GF', 'Interrupting (kA)']],
  ['breaker', 'MV breaker + relay', ['Manufacturer', 'Type', 'Rated kV', 'Continuous (A)', 'Interrupting (kA)', 'Relay model', 'CT ratio', 'Relay settings']],
  ['fuse', 'LV fuse', ['Manufacturer', 'Class', 'Catalog no.', 'Amps', 'Voltage (V)', 'Switch rating (A)']],
  ['fuse', 'MV fuse', ['Manufacturer', 'Type', 'E / K rating', 'Rated kV']],
  ['cable', 'Feeder', ['Size', 'Sets per phase', 'Material (Cu/Al)', 'Insulation', 'Raceway', 'Length (ft)', 'From', 'To']],
  ['cable', 'Busway', ['Manufacturer', 'Ampacity (A)', 'Material (Cu/Al)', 'Length (ft)', 'From', 'To']],
  ['panel', 'Panelboard', ['Manufacturer', 'Model', 'Voltage (V)', 'Bus (A)', 'Main (MCB/MLO)', 'Main size (A)', 'SCCR (kA)', 'Fed from']],
  ['panel', 'Switchboard / gear', ['Manufacturer', 'Model', 'Voltage (V)', 'Bus (A)', 'Bus bracing (kA)', 'Main device', 'Fed from']],
  ['panel', 'MCC', ['Manufacturer', 'Model', 'Voltage (V)', 'Horizontal bus (A)', 'Bus bracing (kA)', 'Fed from']],
  ['transformer', 'Dry type', ['Manufacturer', 'kVA', 'Primary (V)', 'Secondary (V)', '%Z', 'Connection', 'Temp rise']],
  ['transformer', 'Liquid filled', ['Manufacturer', 'kVA', 'Primary (V)', 'Secondary (V)', '%Z', 'Connection', 'Fluid']],
  ['other', 'Motor', ['HP', 'Voltage (V)', 'FLA', 'Starter type']],
  ['other', 'Generator', ['Manufacturer', 'kW / kVA', 'Voltage (V)', "X''d"]],
  ['other', 'Disconnect', ['Manufacturer', 'Amps', 'Fused (Y/N)', 'Voltage (V)']],
  ['other', 'Generic', []],
].map(([type, name, fields], i) => ({ id: `default-${i + 1}`, type, name, fields, order: i }));

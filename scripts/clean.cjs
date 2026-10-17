'use strict';

// Delete only this project's generated compiler output, never source or config.
const { rmSync } = require('node:fs');
const { resolve } = require('node:path');
rmSync(resolve(__dirname, '..', 'out'), { recursive: true, force: true });

#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootDirectory = path.resolve(backendDirectory, '..');
const sidecarDirectory = path.join(rootDirectory, 'sidecar');
const venvDirectory = path.join(sidecarDirectory, '.venv');
const venvPython = path.join(venvDirectory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const requirementsPath = path.join(sidecarDirectory, 'requirements.txt');
const requirementsMarker = path.join(venvDirectory, '.requirements-sha256');
const sidecarEnvironmentKeys = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SCREENER_CACHE_TTL_SECONDS', 'SCREENER_MAX_CONCURRENCY', 'SCREENER_TIMEOUT_SECONDS',
]);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function commandExists(command) {
  return command && spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

export function isSupportedPythonVersion(value) {
  const match = /^(\d+)\.(\d+)$/.exec(String(value).trim());
  return Boolean(match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 12)));
}

function pythonVersion(command) {
  const result = spawnSync(command, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function findPython() {
  for (const command of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    if (isSupportedPythonVersion(pythonVersion(command))) return command;
  }
  throw new Error('Python 3.12 or newer is required. Install it from https://www.python.org/downloads/');
}

function prepareSidecar() {
  const uv = [process.env.UV, 'uv'].find(commandExists);
  if (!fs.existsSync(venvPython)) {
    console.log('Preparing the Python screener for first use…');
    const python = findPython();
    if (uv) run(uv, ['venv', '--python', python, venvDirectory]);
    else run(python, ['-m', 'venv', venvDirectory]);
  } else if (!isSupportedPythonVersion(pythonVersion(venvPython))) {
    throw new Error('sidecar/.venv must use Python 3.12 or newer. Recreate it after installing a supported Python version.');
  }
  const requirements = fs.readFileSync(requirementsPath);
  const expectedHash = createHash('sha256').update(requirements).digest('hex');
  const installedHash = fs.existsSync(requirementsMarker) ? fs.readFileSync(requirementsMarker, 'utf8').trim() : '';
  if (installedHash !== expectedHash) {
    console.log('Installing Python screener dependencies…');
    if (uv) {
      run(uv, ['pip', 'install', '--python', venvPython, '--requirement', requirementsPath]);
    } else {
      if (spawnSync(venvPython, ['-m', 'pip', '--version'], { stdio: 'ignore' }).status !== 0) {
        run(venvPython, ['-m', 'ensurepip', '--upgrade']);
      }
      run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--requirement', requirementsPath]);
    }
    fs.writeFileSync(requirementsMarker, `${expectedHash}\n`);
  }
}

function loadRuntimeEnvironment() {
  const envPath = path.join(rootDirectory, '.env');
  if (!fs.existsSync(envPath)) throw new Error('Missing .env. Run `npm run setup` first.');
  const fileValues = dotenv.parse(fs.readFileSync(envPath));
  return {
    ...fileValues,
    ...process.env,
    PORT: process.env.PORT ?? fileValues.PORT ?? fileValues.BACKEND_PORT ?? '3000',
    SERVER_HOST: process.env.SERVER_HOST ?? fileValues.SERVER_HOST ?? '127.0.0.1',
    PYTHON_SIDECAR_URL: process.env.PYTHON_SIDECAR_URL ?? fileValues.PYTHON_SIDECAR_URL ?? 'http://127.0.0.1:8000',
  };
}

export function createSidecarEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => sidecarEnvironmentKeys.has(key) || key.startsWith('LC_')));
}

export function parseLocalSidecarUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PYTHON_SIDECAR_URL must be a loopback HTTP origin when using npm run app.');
  }
  return { host: url.hostname, port: url.port || '80' };
}

function printHelp() {
  console.log(`Wheely Nilly local launcher

Usage:
  npm run app

Starts the Node backend and Python screener locally. The first run creates an
ignored Python virtual environment and installs its dependencies. Press Ctrl+C
to stop both services.`);
}

export function runLocalApp() {
  const env = loadRuntimeEnvironment();
  const sidecar = parseLocalSidecarUrl(env.PYTHON_SIDECAR_URL);
  prepareSidecar();
  const children = [
    spawn(venvPython, ['-m', 'uvicorn', 'app.main:app', '--host', sidecar.host, '--port', sidecar.port], {
      cwd: sidecarDirectory,
      env: createSidecarEnvironment(env),
      stdio: 'inherit',
    }),
    spawn(process.execPath, ['src/server.js'], {
      cwd: backendDirectory,
      env,
      stdio: 'inherit',
    }),
  ];
  let stopping = false;

  const terminate = (signal) => {
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  };

  process.on('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => terminate('SIGTERM'), 1000).unref();
  });
  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    terminate('SIGTERM');
  });
  for (const child of children) {
    child.once('exit', (code) => {
      if (!stopping) {
        process.exitCode = code || 1;
        stopping = true;
        terminate('SIGTERM');
      }
      if (children.every((service) => service.exitCode !== null)) process.exit(process.exitCode ?? 0);
    });
  }

  console.log(`\nWheely Nilly is starting at http://127.0.0.1:${env.PORT}\nPress Ctrl+C to stop it.\n`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runLocalApp();
  } catch (error) {
    console.error(`Unable to start Wheely Nilly: ${error.message}`);
    process.exitCode = 1;
  }
}

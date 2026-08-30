import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const headlessLinuxGuide = readFileSync('docs/reference/headless-linux-server.md', 'utf8')
const headlessLinuxProse = headlessLinuxGuide.replace(/\s+/g, ' ')

function readSystemdUnitBlocks(doc, unitName) {
  const escapedUnitName = unitName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...doc.matchAll(new RegExp(`^# /etc/systemd/system/${escapedUnitName}$`, 'gm'))].map(
    (match) => {
      const start = match.index + match[0].length
      const end = doc.indexOf('```', start)
      const nextUnitHeaderOffset = doc.slice(start).search(/^# \/etc\/systemd\/system\/.+$/m)
      const nextUnitHeader = nextUnitHeaderOffset === -1 ? -1 : start + nextUnitHeaderOffset
      if (end === -1 || (nextUnitHeader !== -1 && end > nextUnitHeader)) {
        throw new Error(`Missing closing code fence for ${unitName}`)
      }
      return doc.slice(start, end)
    }
  )
}

describe('headless serve shutdown PR gate', () => {
  it('reads only exact, closed systemd unit blocks', () => {
    expect(
      readSystemdUnitBlocks('# /etc/systemd/system/orca-serveXservice\n```', 'orca-serve.service')
    ).toEqual([])
    expect(() =>
      readSystemdUnitBlocks('# /etc/systemd/system/orca-serve.service\n', 'orca-serve.service')
    ).toThrow('Missing closing code fence for orca-serve.service')
    expect(() =>
      readSystemdUnitBlocks(
        '# /etc/systemd/system/orca-serve.service\n' +
          'KillMode=mixed\n' +
          '# /etc/systemd/system/other.service\n```',
        'orca-serve.service'
      )
    ).toThrow('Missing closing code fence for orca-serve.service')
  })

  it('packages an x64 AppImage before running the Docker signal oracle', () => {
    const steps = workflow.jobs.package.steps
    const packageStep = steps.find((step) => step.name === 'Package unpacked app')
    const shutdownStep = steps.find((step) => step.name === 'Verify headless serve signal shutdown')

    expect(packageStep.run).toContain('--linux AppImage --x64 --publish never')
    expect(shutdownStep.run).toBe(
      'node config/scripts/run-headless-serve-shutdown-docker.mjs --appimage dist/orca-linux.AppImage'
    )
    expect(steps.indexOf(shutdownStep)).toBeGreaterThan(steps.indexOf(packageStep))
  })

  it('keeps owned Xvfb alive during the documented systemd graceful stop', () => {
    const serveUnits = readSystemdUnitBlocks(headlessLinuxGuide, 'orca-serve.service')
    const ownedXvfbUnits = serveUnits.filter((unit) => !/^Environment=DISPLAY=/m.test(unit))
    const managedXvfbUnits = serveUnits.filter((unit) => /^Environment=DISPLAY=/m.test(unit))

    expect(ownedXvfbUnits).toHaveLength(1)
    expect(ownedXvfbUnits[0]).toMatch(/^ExecStart=.*orca-linux\.AppImage serve.*$/m)
    expect(ownedXvfbUnits[0]).toMatch(/^KillMode=mixed$/m)
    expect(managedXvfbUnits).toHaveLength(1)
    expect(managedXvfbUnits[0]).not.toMatch(/^KillMode=/m)
  })

  it('distinguishes persisted state from live work during a service restart', () => {
    expect(headlessLinuxProse).toContain(
      'Every `systemctl stop` or `restart` therefore ends live terminals and agent processes'
    )
    expect(headlessLinuxProse).toContain(
      'These guarantees do not preserve live processes. The service restart kills every terminal and agent in its cgroup'
    )
    expect(headlessLinuxProse).toContain(
      'Proceed only when it is untruncated, has an explicit `hostScope` covering every expected execution host, has no `omittedHostIds`, and lists no terminals'
    )
    expect(headlessLinuxGuide).not.toContain('Two facts make this safe and predictable')
  })

  it('uses the registered CLI name from ordinary Linux shells', () => {
    const commandRule =
      'The registered Linux CLI command is `orca-ide`, not `orca`, to avoid shadowing the GNOME Orca screen reader.'
    const substitutionRule =
      "Bare `orca` is available only through Orca's terminal-scoped shim; from an ordinary shell, substitute `orca-ide` for `orca` in commands below."

    expect(headlessLinuxProse).toContain(commandRule)
    expect(headlessLinuxProse).toContain(substitutionRule)
    expect(headlessLinuxProse.indexOf(substitutionRule)).toBeLessThan(
      headlessLinuxProse.indexOf('`orca terminal list --json`')
    )
  })
})

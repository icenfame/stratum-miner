import { ChildProcess, execFile } from 'child_process'
import EventEmitter from 'events'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { BitString, Cell } from 'ton'

interface MinedBody {
    op?: bigint
    flags?: bigint
    expire?: bigint
    whom?: bigint
    rdata1?: bigint
    rseed?: bigint
    rdata2?: bigint
}

const getBitStringSlices = (bits: BitString, slices: number[]): bigint[] => {
    if (!slices.length || !bits.length) return []

    let from = 0

    return slices.map((slice) => getBitStringSliceBigInt(bits, from, (from += slice)))
}

const getBitStringSliceBigInt = (bits: BitString, from: number, to: number): bigint => {
    const slice = bits.toString().slice(from, to)

    return BigInt(`0b${slice || 0}`)
}

const parseMinedBody = (bits: BitString): MinedBody => {
    const slices = [32, 8, 32, 256, 256, 128, 256]
    const [op, flags, expire, whom, rdata1, rseed, rdata2] = getBitStringSlices(bits, slices)
    const parsed: MinedBody = { op, flags, expire, whom, rdata1, rseed, rdata2 }

    return parsed
}

export interface Benchmark extends EventEmitter {
    on(event: 'done', listener: (error: Error | null, result?: [number, number]) => void): this
    on(event: 'progress', listener: (progress: number) => void): this

    once(event: 'done', listener: (error: Error | null, result?: [number, number]) => void): this
    once(event: 'progress', listener: (progress: number) => void): this
}

interface Miner {
    emit(event: 'error', error: Error): boolean
    emit(event: 'success', solution: [string, string, string, string]): boolean

    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'success', listener: (solution: [string, string, string, string]) => void): this

    once(event: 'error', listener: (error: Error) => void): this
    once(event: 'success', listener: (solution: [string, string, string, string]) => void): this
}

class Miner extends EventEmitter {
    public id: number

    private expired = ''
    private complexity = ''
    private giver = ''
    private iterations = '1000000000000000'
    private minerPath: string
    private ref?: ChildProcess = undefined
    private seed = ''
    private solutionPath: string
    private stopped = false
    private wallet: string

    constructor(id: number, wallet: string, minerPath: string, dataDir: string) {
        super()
        this.id = id
        this.minerPath = minerPath
        this.solutionPath = resolve(dataDir, `${this.id}-mined.boc`)
        this.wallet = wallet
    }

    // TODO: add prototype method for stopping the benchmark
    static benchmark(bin: string, id: number, timeout = 10): Benchmark {
        const events: Benchmark = new EventEmitter()
        const child = execFile(
            resolve(__dirname, '..', '..', 'bin', bin),
            [
                ...['-vv', '-g', id.toString(10), '-B', '-t', timeout.toString(10)],
                'kQBWkNKqzCAwA9vjMwRmg7aY75Rf8lByPA9zKXoqGkHi8SM7',
                '229760179690128740373110445116482216837',
                '5391989333430127958933403017403926134727428884508114496220722049840',
                '10000000000000000000'
            ],
            (error, stdout, stderr) => {
                if (error) {
                    const lines = error.message.trim().split('\n')
                    // remove colors and leading log tags
                    const rawLine = (lines[lines.length - 1] || 'unknown error')
                        .replace('\u001b[1;36m', '')
                        .replace('\u001b[1;31m', '')
                        .replace('\u001b[0m', '')
                        .replace(/^\[[^\]]+\]\[[^\]]+\]\[[^\]]+\]/, '')

                    return events.emit('done', new Error(rawLine))
                }

                const [, boost = '16'] = stderr.match(/best boost factor: +(\d+)/) || []
                const [, hashrate = '0'] = stderr.match(/best speed: +(\d+)/) || []

                return events.emit('done', null, [Number.parseInt(boost, 10), Number.parseInt(hashrate, 10)])
            }
        )

        if (child.stderr) {
            const step = /cuda/.test(bin) ? 6 : 9
            let attempt = 0

            child.stderr.on('data', (line: string) => {
                if (/START MINER/.test(line)) {
                    // progress is approximate and can slow down towards the end
                    events.emit('progress', step * attempt++)
                }
            })
        }

        return events
    }

    setComplexity(complexity: string) {
        this.complexity = complexity
    }

    setTarget(seed: string, expired: string, giver: string, wallet: string) {
        this.seed = seed
        this.expired = expired
        this.giver = giver
        this.wallet = wallet

        this.ref ? this.ref.kill() : this.run()
    }

    static getDevices(binary: string): Promise<string[]> {
        const minerPath = resolve(__dirname, '../..', 'bin', binary)

        return new Promise((resolve, reject) => {
            execFile(minerPath, (error, stdout, stderr) => {
                const re = /^(\[ [^\]]+ \])/gim
                const matches = [...stderr.matchAll(re)]
                const devices = matches
                    .map((el) => {
                        const reStart = /^\[ (OpenCL: platform #[0-9]+ device #[0-9]+|GPU #[0-9]+:) /gim
                        const reEnd = / \](.*)/gim
                        const device = el?.[0]?.replace(reStart, '').replace(reEnd, '')

                        return device
                    })
                    .filter((el): el is string => el !== undefined)

                if (!devices.length) {
                    return reject(stderr)
                }

                resolve(devices)
            })
        })
    }

    private run(): void {
        // once stopped, calling start() followed by setTarget() will start the mining loop again
        if (this.stopped) {
            return undefined
        }

        this.ref = execFile(
            this.minerPath,
            [
                '-vv',
                ...['-g', this.id.toString()],
                ...['-t', '100'],
                ...['-e', this.expired],
                this.wallet,
                ...[this.seed, this.complexity, this.iterations, this.giver],
                this.solutionPath
            ],
            { timeout: 0 },
            (error, stdout, stderr) => {
                this.ref = undefined

                if (error && error.code && error.code > 1) {
                    this.emit("error", new Error(`[${this.id}] miner had unexpected exit code ${error.code} with error: ${error.message.trim()}`)) // prettier-ignore
                }
                if (error) {
                    return this.run()
                }

                if (!stderr.includes('Saving')) {
                    this.emit("error", new Error(`[${this.id}] unexpected behavior in miner: exit code 0 and failed to match "Saving" in stderr: ${stderr.trim()}`)) // prettier-ignore

                    return this.run()
                }

                try {
                    const solution = readFileSync(this.solutionPath, 'hex')
                    const mined = Cell.fromBoc(solution)
                    const body = mined[0]?.refs[0]?.bits

                    if (!body) {
                        throw new Error("Can't read .boc")
                    }

                    const { expire, rdata1, rseed } = parseMinedBody(body)

                    this.emit('success', [
                        expire?.toString() || '',
                        rdata1?.toString() || '',
                        rseed?.toString() || '',
                        ''
                    ])
                } catch (readFileError) {
                    this.emit("error", new Error(`[${this.id}] miner failed to read boc file ${this.solutionPath} with error: ${(readFileError as Error).message}`)) // prettier-ignore
                }

                return this.run()
            }
        )
    }

    start() {
        this.stopped = false
    }

    stop() {
        this.stopped = true
        this.ref?.kill()
    }
}

export default Miner
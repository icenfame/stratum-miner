/* eslint-disable @typescript-eslint/no-non-null-assertion */
import EventEmitter from 'events'
import Client from './client'
import { Config } from './config'
import Miner from './miner'

interface TonPoolClient {
    on(event: 'connect', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'reconnect', listener: () => void): this
    on(event: 'stop', listener: () => void): this
    on(event: 'submit', listener: () => void): this

    once(event: 'connect', listener: () => void): this
    once(event: 'error', listener: (error: Error) => void): this
    once(event: 'reconnect', listener: () => void): this
    once(event: 'stop', listener: () => void): this
    once(event: 'submit', listener: () => void): this
}

class TonPoolClient extends EventEmitter {
    public readonly DISCONNECTED = 0
    public readonly CONNECTING = 1
    public readonly CONNECTED = 2
    public readonly RECONNECTING = 3
    public readonly MINING = 4
    public state:
        | TonPoolClient['DISCONNECTED']
        | TonPoolClient['CONNECTING']
        | TonPoolClient['CONNECTED']
        | TonPoolClient['RECONNECTING']
        | TonPoolClient['MINING'] = this.DISCONNECTED

    private client?: Client

    constructor() {
        super()
    }

    start(config: Config): void {
        console.log('starting client...')
        console.log(`mining for wallet ${config.wallet}`)

        const onError = (error: Error) => {
            console.log(error.message)
            this.emit('error', error)
        }

        const miners = config.gpus.map((id) =>
            new Miner(Number.parseInt(id, 10), config.wallet, config.minerPath, config.dataDir).on(
                'error',
                ({ message }) => onError(new Error(`miner error: ${message}`))
            )
        )

        console.log(`mining using ${miners.length} gpus`)

        console.log(`choosen pool is "${config.pool.replace('wss://', '')}"`)

        let reconnecting = false
        this.client = new Client(config.pool, config.wallet, config.rig, config.version)
            .on('close', (code, reason) => {
                console.log(`connection closed with ${code} ${reason}`)

                this.state = this.DISCONNECTED
                this.emit('stop')

                miners.forEach((miner) => miner.stop())
            })
            .on('error', ({ message }) => onError(new Error(`connection error: ${message}`)))
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            .on('open', async () => {
                reconnecting = false
                miners.forEach((miner) => miner.start())
                console.log('connection established')

                // TODO: move subscribe() and authorize() inside the Client
                // TODO: do not reconnect when server rejects subscribe or authorize requests
                try {
                    const result = await this.client!.subscribe()
                    console.log('connection subscribed')
                    miners.forEach((miner) => miner.setComplexity(result[1]))

                    await this.client!.authorize()
                    console.log('connection authorized')

                    this.state = this.CONNECTED
                    this.emit('connect')
                } catch (error) {
                    onError(new Error(`connection error: ${(error as Error).message}`))
                }
            })
            .on('message', (message) => {
                if ('method' in message && message.method === 'mining.set_target') {
                    console.log('new job received')

                    this.state = this.MINING

                    miners.forEach((miner) => miner.setTarget(...message.params))
                }
            })
            .on('reconnect', () => {
                if (!reconnecting) {
                    console.log('connection lost, reconnecting...')

                    reconnecting = true
                    this.state = this.RECONNECTING
                    this.emit('reconnect')

                    miners.forEach((miner) => miner.stop())
                }
            })

        console.log('connecting to the server...')

        this.state = this.CONNECTING

        miners.forEach((miner) => {
            miner.on('success', (solution) => {
                this.client!.submit(solution).then(
                    () => {
                        console.log('share submitted')
                        this.emit('submit')
                    },
                    ({ message }: Error) => onError(new Error(`miner error: failed to submit share: ${message}`))
                )
            })
        })
    }

    stop(): Promise<void> {
        console.log('stopping client...')

        if (!this.client || this.client.closed) {
            return Promise.resolve()
        }

        return Promise.all([new Promise((resolve) => this.client!.once('close', resolve)), this.client.destroy()]).then(
            () => undefined
        )
    }
}

const tonPoolClient = new TonPoolClient()
export default tonPoolClient
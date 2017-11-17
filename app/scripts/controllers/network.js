const assert = require('assert')
const EventEmitter = require('events')
const createMetamaskProvider = require('web3-provider-engine/zero.js')
const ObservableStore = require('obs-store')
const ComposedStore = require('obs-store/lib/composed')
const extend = require('xtend')
const Eth = require('ethjs')
const createEventEmitterProxy = require('../lib/events-proxy.js')
const RPC_ADDRESS_LIST = require('../config.js').network
const DEFAULT_RPC = RPC_ADDRESS_LIST['rinkeby']

module.exports = class NetworkController extends EventEmitter {

  constructor (config) {
    super()
    config.provider.rpcTarget = this.getRpcAddressForType(config.provider.type, config.provider)
    this.networkStore = new ObservableStore('loading')
    this.providerStore = new ObservableStore(config.provider)
    this.store = new ComposedStore({ provider: this.providerStore, network: this.networkStore })
    this._proxy = createEventEmitterProxy()

    this.lookupNetwork = this.lookupNetwork.bind(this)

    this.on('userChangedNetwork', () => this.emit('networkDidChange'))
    this.on('networkDidChange', this.lookupNetwork)
  }

  initializeProvider (_providerParams) {
    this._baseProviderParams = _providerParams
    const rpcUrl = this.getCurrentRpcAddress()
    this._configureStandardProvider({ rpcUrl })
    this._proxy.on('block', this._logBlock.bind(this))
    this._proxy.on('error', this.verifyNetwork.bind(this))
    this.eth = new Eth(this._proxy)
    this.lookupNetwork()
    return this._proxy
  }

  verifyNetwork () {
    // Check network when restoring connectivity:
    console.log(`verifying network if loading, ${this.isNetworkLoading()}`)
    if (this.isNetworkLoading()) this.lookupNetwork()
  }

  getNetworkState () {
    return this.networkStore.getState()
  }

  setNetworkState (network) {
    console.trace('SETTING NETWORK')
    console.dir(network)
    return this.networkStore.putState(network)
  }

  isNetworkLoading () {
    return this.getNetworkState() === 'loading'
  }

  async lookupNetwork () {
    console.log('looking up network')
    // Prevent firing when provider is not defined.
    if (!this.eth) {
      console.log('no provider detected', this.eth)
      return
    }

    let network
    try {
      network = await this.eth.net_version()
      console.log('network retrieved', network)
    } catch (err) {
      console.log('failed to get version ', err)
      return this.setNetworkState('loading')
    }

    console.log('setting state to ', network)
    this.setNetworkState(network)
    log.info('web3.getNetwork returned ' + network)
  }

  setRpcTarget (rpcUrl) {
    this.providerStore.updateState({
      type: 'rpc',
      rpcTarget: rpcUrl,
    })
    this._switchNetwork({ rpcUrl })
    this.emit('userChangedNetwork')
  }

  getCurrentRpcAddress () {
    const provider = this.getProviderConfig()
    if (!provider) return null
    return this.getRpcAddressForType(provider.type)
  }

  async setProviderType (type) {
    assert(type !== 'rpc', `NetworkController.setProviderType - cannot connect by type "rpc"`)
    // skip if type already matches
    if (type === this.getProviderConfig().type) return
    const rpcTarget = this.getRpcAddressForType(type)
    assert(rpcTarget, `NetworkController - unknown rpc address for type "${type}"`)
    this.providerStore.updateState({ type, rpcTarget })
    this._switchNetwork({ rpcUrl: rpcTarget })
    this.emit('userChangedNetwork')
  }

  getProviderConfig () {
    return this.providerStore.getState()
  }

  getRpcAddressForType (type, provider = this.getProviderConfig()) {
    if (RPC_ADDRESS_LIST[type]) return RPC_ADDRESS_LIST[type]
    return provider && provider.rpcTarget ? provider.rpcTarget : DEFAULT_RPC
  }

  // Sometimes the provider is changed without notice.
  // This method is used for detecting that the provider is not the same
  // as one that was known before.
  async detectProviderChange () {
    // After recent blocks controller is added
    if (!('recentBlocks' in this)) {
      return
    }

    const { recentBlocks } = this
    const { blocks } = recentBlocks.store.getState().recentBlocks

    const earliest = blocks[0]
    const middle = blocks[Math.round(blocks.length / 2)]

    const [ earlyCheck, middleCheck, syncing ] = await Promise.all([
      eth.getBlockByHash(earliest.hash),
      eth.getBlockByHash(middle.hash),
      eth.syncing(),
    ])

    console.log('COMPARING BLOCK HASHES', earliest.hash, earlyCheck.hash)

    if ((earliest.hash !== earlyCheck.hash ||
         middle.hash !== middleCheck.hash) && !syncing) {
      this._switchNetwork(this._baseProviderParams)
    }
  }

  //
  // Private
  //

  _switchNetwork (providerParams) {
    this.setNetworkState('loading')
    this._configureStandardProvider(providerParams)
    this.emit('networkDidChange')
  }

  _configureStandardProvider (_providerParams) {
    const providerParams = extend(this._baseProviderParams, _providerParams)
    const provider = createMetamaskProvider(providerParams)
    this._setProvider(provider)
  }

  _setProvider (provider) {
    // collect old block tracker events
    const oldProvider = this._provider
    let blockTrackerHandlers
    if (oldProvider) {
      // capture old block handlers
      blockTrackerHandlers = oldProvider._blockTracker.proxyEventHandlers
      // tear down
      oldProvider.removeAllListeners()
      oldProvider.stop()
    }
    // override block tracler
    provider._blockTracker = createEventEmitterProxy(provider._blockTracker, blockTrackerHandlers)
    // set as new provider
    this._provider = provider
    this._proxy.setTarget(provider)
  }

  _logBlock (block) {
    log.info(`BLOCK CHANGED: #${block.number.toString('hex')} 0x${block.hash.toString('hex')}`)
    this.verifyNetwork()
  }
}


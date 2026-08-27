import { createContext, FormEvent, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownRight, ArrowLeftRight, ArrowUpRight, ChevronDown, CircleDollarSign,
  AlertTriangle, Eye, EyeOff, FileCheck2, KeyRound, LayoutDashboard, Link2, Monitor, MoreHorizontal, PieChart as PieIcon, Plus, QrCode,
  ReceiptText, RefreshCw, Search, Settings, ShieldCheck, Smartphone, Trash2, TrendingUp, Unplug,
  WalletCards, WandSparkles, X,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { QRCodeSVG } from 'qrcode.react'
import { format, parseISO } from 'date-fns'
import { enUS } from 'date-fns/locale'
import { categorySeries, dailySeries, lastDays, money, parseAmount, summarize } from './finance'
import { demoTransactions } from './data'
import {
  currencies, currencyDetails, expenseCategories, incomeCategories, isCurrencyCode,
  type CurrencyCode, type Transaction, type TransactionType,
} from './types'
import { categorizeWithAi, configureOpenRouter, localCategory } from './ai'
import leafyIcon from '../src-tauri/icons/app-icon.svg'
import { secureGet, secureSet } from './storage'
import { analyzeReceipt, isSharedReceipt, type SharedReceipt } from './receipt'
import {
  createPairing, forgetPeer, mergeTransactions, parsePairing, pullFromPeer, pushToPeer,
  rememberPeer, savedPeer, scanPairingCode, serializePairing, type PairingDetails,
} from './sync'
import { checkForUpdates, openRelease, type UpdateCheck } from './updates'

const COLORS: Record<string, string> = {
  Food: '#d9a441', Housing: '#718bdb', Transport: '#51a98e', Leisure: '#d86f91',
  Health: '#62b978', Shopping: '#9b79d1', Subscriptions: '#4b9fc3', Other: '#82948a',
}

const CurrencyContext = createContext<CurrencyCode>('BRL')
const useCurrency = () => useContext(CurrencyContext)
type DashboardSection = 'overview' | 'transactions' | 'insights'

function useTransactions() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState(false)
  useEffect(() => {
    void (async () => {
      try {
        let rows = await secureGet<Transaction[]>('transactions')
        if (!rows) {
          const legacy = localStorage.getItem('leafy-transactions') ?? localStorage.getItem('lumina-transactions')
          rows = legacy ? JSON.parse(legacy) as Transaction[] : new URLSearchParams(window.location.search).has('demo') ? demoTransactions : []
          await secureSet('transactions', rows)
          localStorage.removeItem('leafy-transactions')
          localStorage.removeItem('lumina-transactions')
        }
        setTransactions(rows)
      } catch {
        setStorageError(true)
      } finally { setReady(true) }
    })()
  }, [])
  useEffect(() => {
    if (ready && !storageError) void secureSet('transactions', transactions).catch(() => setStorageError(true))
  }, [ready, storageError, transactions])
  return [transactions, setTransactions, ready, storageError] as const
}

function StatCard({ label, value, type, note, hidden }: { label: string; value: number; type: 'balance' | 'income' | 'expense'; note: string; hidden?: boolean }) {
  const Icon = type === 'income' ? ArrowUpRight : type === 'expense' ? ArrowDownRight : WalletCards
  const currency = useCurrency()
  return (
    <article className={`stat-card ${type}`}>
      <div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={18} /></span></div>
      <strong>{hidden ? `${currencyDetails(currency).symbol} •••••` : money(value, false, currency)}</strong>
      <small>{note}</small>
    </article>
  )
}

function CustomTooltip({ active, payload, label }: any) {
  const currency = useCurrency()
  if (!active || !payload?.length) return null
  return <div className="chart-tooltip"><b>{label}</b>{payload.map((p: any) => <span key={p.name} style={{ color: p.color }}>{p.name}: {money(p.value, false, currency)}</span>)}</div>
}

function AddTransaction({ onClose, onAdd }: { onClose: () => void; onAdd: (row: Transaction, useAi: boolean) => void }) {
  const currency = useCurrency()
  const [type, setType] = useState<TransactionType>('expense')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const categories = type === 'expense' ? expenseCategories : incomeCategories
  const [category, setCategory] = useState('Auto')

  useEffect(() => setCategory('Auto'), [type])
  useEffect(() => document.querySelector<HTMLInputElement>('#amount')?.focus(), [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = parseAmount(amount)
    if (!value || value <= 0) return
    const automatic = category === 'Auto'
    const label = description.trim() || (type === 'expense' ? 'Expense' : 'Income')
    onAdd({ id: crypto.randomUUID(), type, amount: value, description: label, category: automatic ? 'Other' : category, date: format(new Date(), 'yyyy-MM-dd') }, automatic)
  }

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="quick-entry" onSubmit={submit}>
        <div className="entry-head">
          <div><span className="eyebrow">Quick entry</span><h2>What happened?</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="type-switch">
          <button type="button" className={type === 'expense' ? 'active expense' : ''} onClick={() => setType('expense')}><ArrowDownRight size={17} /> Spent</button>
          <button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => setType('income')}><ArrowUpRight size={17} /> Received</button>
        </div>
        <label className="amount-field"><span>Amount</span><div><b>{currencyDetails(currency).symbol}</b><input id="amount" inputMode="decimal" maxLength={24} placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} /></div></label>
        <label className="input-label"><span>Description <i>optional</i></span><input maxLength={200} placeholder={type === 'expense' ? 'Example: lunch, groceries...' : 'Example: salary, freelance...'} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <div className="category-field"><span>Category</span><div className="category-chips"><button type="button" className={category === 'Auto' ? 'active auto' : ''} onClick={() => setCategory('Auto')}><WandSparkles size={12} /> Auto</button>{categories.map(item => <button type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div>{category === 'Auto' && <small className="auto-hint">Leafy will categorize it with AI. Local matching is used when offline.</small>}</div>
        <button className={`save-button ${type}`} type="submit">Save {type === 'expense' ? 'expense' : 'income'} <span>↵</span></button>
        <p className="privacy-note">Stored only on this device</p>
      </form>
    </div>
  )
}

function PreferencesPanel({ currency, onCurrencyChange, onClose, onNotice }: {
  currency: CurrencyCode
  onCurrencyChange: (currency: CurrencyCode) => Promise<void>
  onClose: () => void
  onNotice: (message: string) => void
}) {
  const [key, setKey] = useState('')
  const [selectedCurrency, setSelectedCurrency] = useState<CurrencyCode>(currency)
  const [saving, setSaving] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      await onCurrencyChange(selectedCurrency)
      if (key.trim()) await configureOpenRouter(key)
      onNotice(key.trim() ? 'Preferences saved and OpenRouter connected' : 'Preferences saved')
      onClose()
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'OpenRouter is available in the desktop and mobile apps')
    } finally { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <form className="quick-entry preferences-panel" onSubmit={save}>
      <div className="entry-head"><div><span className="eyebrow">Preferences</span><h2>Money and AI</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20}/></button></div>
      <label className="input-label"><span>Display currency</span><select value={selectedCurrency} onChange={event => setSelectedCurrency(event.target.value as CurrencyCode)}>{currencies.map(item => <option value={item.code} key={item.code}>{item.code} — {item.label}</option>)}</select><small>BRL is the default. Changing this label does not convert existing amounts.</small></label>
      <div className="privacy-callout"><KeyRound size={20}/><div><b>Your key stays on this device</b><span>Leafy sends only the transaction description to OpenRouter when Auto is selected. The key is held in app memory and is never committed or synced.</span></div></div>
      <label className="input-label"><span>OpenRouter API key <i>optional</i></span><input type="password" autoComplete="off" placeholder="sk-or-v1-..." value={key} onChange={event => setKey(event.target.value)} /></label>
      <button className="save-button income" disabled={saving}>{saving ? 'Saving...' : 'Save preferences'}</button>
      <p className="privacy-note">You can also set OPENROUTER_API_KEY before launching Leafy.</p>
    </form>
  </div>
}

function ReceiptReview({ source, onClose, onAdd }: {
  source: SharedReceipt
  onClose: () => void
  onAdd: (row: Transaction, useAi: boolean) => void
}) {
  const currency = useCurrency()
  const detected = useMemo(() => analyzeReceipt(source.text), [source])
  const [type, setType] = useState<TransactionType>(detected.type)
  const [amount, setAmount] = useState(detected.amount?.toFixed(2) ?? '')
  const [description, setDescription] = useState(detected.description)
  const [date, setDate] = useState(detected.date)
  const [category, setCategory] = useState('Auto')
  const categories = type === 'expense' ? expenseCategories : incomeCategories
  const currencyMismatch = detected.currency !== null && detected.currency !== currency

  useEffect(() => setCategory('Auto'), [type])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = parseAmount(amount)
    if (!value || value <= 0) return
    onAdd({
      id: crypto.randomUUID(),
      type,
      amount: value,
      description: description.trim() || (type === 'expense' ? 'Receipt payment' : 'Receipt income'),
      category: category === 'Auto' ? localCategory(description, type) : category,
      date,
    }, false)
  }

  return <div className="modal-backdrop receipt-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <form className="quick-entry receipt-review" onSubmit={submit}>
      <div className="entry-head">
        <div><span className="eyebrow">Shared receipt</span><h2>Review before saving</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20}/></button>
      </div>
      <div className="receipt-source"><FileCheck2 size={20}/><div><b>{source.name}</b><span>Read locally on this device</span></div><em className={detected.confidence}>{detected.confidence} confidence</em></div>
      <div className={`receipt-explanation ${detected.confidence}`}>
        {detected.confidence === 'low' && <AlertTriangle size={18}/>}<span>{detected.explanation}</span>
      </div>
      {currencyMismatch && <div className="receipt-explanation low"><AlertTriangle size={18}/><span>This receipt appears to use {detected.currency}, but your ledger uses {currency}. Change the display currency in Preferences before saving; Leafy does not guess exchange rates.</span></div>}
      <div className="type-switch">
        <button type="button" className={type === 'expense' ? 'active expense' : ''} onClick={() => setType('expense')}><ArrowDownRight size={17}/> Spent</button>
        <button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => setType('income')}><ArrowUpRight size={17}/> Received</button>
      </div>
      <div className="receipt-fields">
        <label className="input-label"><span>Amount ({currencyDetails(currency).symbol})</span><input required inputMode="decimal" maxLength={24} value={amount} onChange={event => setAmount(event.target.value)}/></label>
        <label className="input-label"><span>Date</span><input required type="date" value={date} onChange={event => setDate(event.target.value)}/></label>
      </div>
      <label className="input-label"><span>Description</span><input required maxLength={200} value={description} onChange={event => setDescription(event.target.value)}/></label>
      <div className="category-field"><span>Category</span><div className="category-chips"><button type="button" className={category === 'Auto' ? 'active auto' : ''} onClick={() => setCategory('Auto')}><WandSparkles size={12}/> Auto (local)</button>{categories.map(item => <button type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div></div>
      <button className={`save-button ${type}`} type="submit" disabled={currencyMismatch}>Confirm and save {type === 'expense' ? 'expense' : 'income'}</button>
      <p className="privacy-note">Nothing changes until you confirm. Receipt contents are not sent to OpenRouter.</p>
    </form>
  </div>
}

function SyncPanel({ transactions, initialPeer, onClose, onPaired, onMerge }: {
  transactions: Transaction[]
  initialPeer: PairingDetails | null
  onClose: () => void
  onPaired: (peer: PairingDetails | null) => void
  onMerge: (rows: Transaction[]) => void
}) {
  const [mode, setMode] = useState<'show' | 'scan'>('show')
  const [peer, setPeer] = useState<PairingDetails | null>(initialPeer)
  const [pairingText, setPairingText] = useState('')
  const [status, setStatus] = useState(initialPeer ? 'Connected on your local network' : '')
  const [busy, setBusy] = useState(false)

  const showCode = async () => {
    setBusy(true); setStatus('Starting a private local connection...')
    try {
      const next = await createPairing(transactions)
      await rememberPeer(next); setPeer(next); onPaired(next); setStatus('Ready for one hour. Scan this code with Leafy on your phone.')
    } catch { setStatus('Open Leafy as a desktop app to create a pairing code.') }
    finally { setBusy(false) }
  }

  const connect = async (details?: PairingDetails) => {
    setBusy(true); setStatus('Connecting securely...')
    try {
      const next = details ?? parsePairing(pairingText.trim())
      const rows = await pullFromPeer(next)
      await rememberPeer(next); setPeer(next); onPaired(next); onMerge(rows)
      setStatus(`Connected. Imported ${rows.length} transactions.`)
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Could not connect') }
    finally { setBusy(false) }
  }

  const scanCode = async () => {
    setBusy(true)
    try { await connect(await scanPairingCode()) }
    catch (error) { setStatus(error instanceof Error ? error.message : 'Could not scan the code'); setBusy(false) }
  }

  const disconnect = () => { forgetPeer(); setPeer(null); onPaired(null); setStatus('Device disconnected') }
  const code = peer ? serializePairing(peer) : ''
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="quick-entry sync-panel">
      <div className="entry-head"><div><span className="eyebrow">Private sync</span><h2>Connect your devices</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20}/></button></div>
      <div className="sync-tabs"><button className={mode === 'show' ? 'active' : ''} onClick={() => setMode('show')}><Monitor size={16}/> This computer</button><button className={mode === 'scan' ? 'active' : ''} onClick={() => setMode('scan')}><Smartphone size={16}/> This phone</button></div>
      {mode === 'show' ? <div className="sync-content">
        {code ? <><div className="qr-frame"><QRCodeSVG value={code} size={320} level="L" marginSize={4} bgColor="#ffffff" fgColor="#000000" /></div><p>On your phone, open <b>Leafy → Devices → This phone</b> and use Leafy's scanner—not the regular Camera app.</p></> : <div className="sync-empty"><QrCode size={42}/><b>Pair with your phone</b><span>Both devices need to be on the same Wi-Fi network for the first private sync.</span><button onClick={showCode} disabled={busy}><Link2 size={16}/>{busy ? 'Starting...' : 'Create pairing code'}</button></div>}
      </div> : <div className="sync-content scan-content">
        <div className="phone-graphic"><Smartphone size={38}/><span><i/></span></div><b>Scan the code on your computer</b><p>The time-limited QR carries a pinned TLS certificate and a separate 256-bit encryption key. Your financial data remains end-to-end encrypted.</p>
        <button className="scan-button" onClick={scanCode} disabled={busy}><QrCode size={17}/>{busy ? 'Opening camera...' : 'Scan QR code'}</button>
        <div className="manual-code"><span>or paste the pairing link</span><input aria-label="Pairing link" placeholder="leafy://pair?..." value={pairingText} onChange={event => setPairingText(event.target.value)}/><button onClick={() => connect()} disabled={!pairingText.trim() || busy}>Connect</button></div>
      </div>}
      {status && <div className="sync-status"><ShieldCheck size={16}/><span>{status}</span></div>}
      {peer && <button className="disconnect-button" onClick={disconnect}><Unplug size={15}/>Disconnect this device</button>}
    </div>
  </div>
}

export default function App() {
  const [transactions, setTransactions, storageReady, storageError] = useTransactions()
  const [days, setDays] = useState(30)
  const [showBalance, setShowBalance] = useState(true)
  const [entryOpen, setEntryOpen] = useState(false)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const [sharedReceipt, setSharedReceipt] = useState<SharedReceipt | null>(null)
  const [currency, setCurrency] = useState<CurrencyCode>('BRL')
  const [peer, setPeer] = useState<PairingDetails | null>(null)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheck | null>(null)
  const [activeSection, setActiveSection] = useState<DashboardSection>('overview')
  const profileMenuRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLElement>(null)
  const transactionsRef = useRef<HTMLElement>(null)
  const insightsRef = useRef<HTMLElement>(null)
  const periodRows = useMemo(() => lastDays(transactions, days), [transactions, days])
  const summary = useMemo(() => summarize(periodRows), [periodRows])
  const allSummary = useMemo(() => summarize(transactions), [transactions])
  const chart = useMemo(() => dailySeries(periodRows, days), [periodRows, days])
  const categories = useMemo(() => categorySeries(periodRows), [periodRows])
  const weekSpend = summarize(lastDays(transactions, 7)).expenses
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening'
  const recent = transactions
    .filter(t => `${t.description} ${t.category}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7)

  const scrollToSection = (section: DashboardSection) => {
    setActiveSection(section)
    const target = section === 'overview' ? overviewRef.current : section === 'transactions' ? transactionsRef.current : insightsRef.current
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  useEffect(() => {
    void secureGet<unknown>('currency').then(value => {
      if (isCurrencyCode(value)) setCurrency(value)
    }).catch(() => setToast('Currency preference could not be unlocked. Using BRL.'))
  }, [])

  useEffect(() => {
    const bridgeWindow = window as Window & { __leafyShareReady?: boolean }
    const receive = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail
      if (isSharedReceipt(value)) setSharedReceipt(value)
      else setToast('Leafy rejected an invalid shared receipt.')
    }
    const receiveError = (event: Event) => {
      const value = (event as CustomEvent<{ message?: unknown }>).detail
      setToast(typeof value?.message === 'string' ? value.message : 'Leafy could not read this shared receipt.')
    }
    bridgeWindow.__leafyShareReady = true
    window.addEventListener('leafy:shared-receipt', receive)
    window.addEventListener('leafy:share-error', receiveError)
    return () => {
      bridgeWindow.__leafyShareReady = false
      window.removeEventListener('leafy:shared-receipt', receive)
      window.removeEventListener('leafy:share-error', receiveError)
    }
  }, [])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) setEntryOpen(true)
      if (event.key === 'Escape') { setEntryOpen(false); setProfileMenuOpen(false) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  useEffect(() => {
    if (!profileMenuOpen) return
    const close = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [profileMenuOpen])

  useEffect(() => {
    if (storageError) setToast('Private storage could not be unlocked. Changes will not be saved.')
  }, [storageError])

  useEffect(() => {
    void savedPeer().then(setPeer)
  }, [])

  useEffect(() => {
    if (!peer) return
    const remaining = Date.parse(peer.expiresAt) - Date.now()
    const timer = window.setTimeout(() => { forgetPeer(); setPeer(null) }, Math.max(0, remaining))
    return () => window.clearTimeout(timer)
  }, [peer])

  useEffect(() => {
    if (!peer || !storageReady) return
    const sync = async () => {
      try {
        const incoming = await pullFromPeer(peer)
        setTransactions(current => {
          const merged = mergeTransactions(current, incoming)
          return JSON.stringify(merged) === JSON.stringify(current) ? current : merged
        })
      } catch { /* The peer may be offline. Local entries remain safe. */ }
    }
    sync()
    const timer = window.setInterval(sync, 5000)
    return () => window.clearInterval(timer)
  }, [peer, setTransactions, storageReady])

  useEffect(() => {
    if (!peer || !storageReady) return
    const timer = window.setTimeout(() => pushToPeer(peer, transactions).catch(() => undefined), 700)
    return () => window.clearTimeout(timer)
  }, [peer, transactions, storageReady])

  const add = async (row: Transaction, useAi: boolean) => {
    if (storageError) {
      setToast('Unlock private storage before adding transactions.')
      return
    }
    setTransactions(current => [row, ...current])
    setEntryOpen(false)
    setToast(row.type === 'expense' ? 'Expense saved' : 'Income saved')
    window.setTimeout(() => setToast(''), 2600)
    if (useAi) {
      const category = await categorizeWithAi(row.description, row.type)
      setTransactions(current => current.map(item => item.id === row.id ? { ...item, category } : item))
      setToast(`Categorized as ${category}`)
      window.setTimeout(() => setToast(''), 2600)
    }
  }
  const remove = (id: string) => storageError
    ? setToast('Unlock private storage before changing transactions.')
    : setTransactions(current => current.filter(t => t.id !== id))

  const checkUpdates = async () => {
    setCheckingUpdates(true)
    try {
      const update = await checkForUpdates()
      if (update.available) {
        setAvailableUpdate(update)
        setToast('')
      } else setToast(`Leafy ${update.currentVersion} is up to date`)
    } catch {
      setToast('Could not check for updates. Try again in a moment.')
    } finally {
      setCheckingUpdates(false)
      setProfileMenuOpen(false)
      window.setTimeout(() => setToast(''), 4200)
    }
  }

  return (
    <CurrencyContext.Provider value={currency}>
    <div className="app-shell">
      <aside>
        <div className="brand"><img className="brand-mark" src={leafyIcon} alt="" /><div>Leafy<small>Private ledger</small></div></div>
        <nav>
          <button className={activeSection === 'overview' && !syncOpen ? 'active' : ''} aria-current={activeSection === 'overview' && !syncOpen ? 'page' : undefined} onClick={() => scrollToSection('overview')}><LayoutDashboard size={19} />Overview</button>
          <button className={activeSection === 'transactions' && !syncOpen ? 'active' : ''} aria-current={activeSection === 'transactions' && !syncOpen ? 'page' : undefined} onClick={() => scrollToSection('transactions')}><ArrowLeftRight size={19} />Transactions</button>
          <button className={activeSection === 'insights' && !syncOpen ? 'active' : ''} aria-current={activeSection === 'insights' && !syncOpen ? 'page' : undefined} onClick={() => scrollToSection('insights')}><PieIcon size={19} />Insights</button>
          <button className={syncOpen ? 'active' : ''} aria-current={syncOpen ? 'page' : undefined} onClick={() => setSyncOpen(true)}><QrCode size={19} />Devices <span className="device-dot">{peer ? '1' : ''}</span></button>
        </nav>
        <div className="side-bottom">
          <div className="weekly-card"><span className="mini-icon"><TrendingUp size={16} /></span><div><small>Spent in 7 days</small><b>{money(weekSpend, false, currency)}</b></div></div>
          <button className="settings" onClick={() => setPreferencesOpen(true)}><Settings size={18} />Preferences</button>
          <div className="profile" ref={profileMenuRef}>
            <span>M</span><div><b>My money</b><small>Local data</small></div>
            <button type="button" className="profile-menu-trigger" aria-label="Account options" aria-haspopup="menu" aria-expanded={profileMenuOpen} onClick={() => setProfileMenuOpen(open => !open)}><MoreHorizontal size={18} /></button>
            {profileMenuOpen && <div className="profile-menu" role="menu">
              <button type="button" role="menuitem" onClick={checkUpdates} disabled={checkingUpdates}><RefreshCw size={15} className={checkingUpdates ? 'spinning' : ''}/>{checkingUpdates ? 'Checking...' : 'Check for updates'}</button>
            </div>}
          </div>
        </div>
      </aside>

      <main>
        <header ref={overviewRef}>
          <div><p>{format(new Date(), 'EEEE, MMMM d', { locale: enUS })}</p><h1>{greeting}<span>Your money, at a glance.</span></h1></div>
          <div className="header-actions">
            <button className="icon-button mobile-settings" onClick={() => setPreferencesOpen(true)} aria-label="Preferences"><Settings size={20} /></button>
            <button className="new-button" onClick={() => setEntryOpen(true)}><Plus size={18} />Add transaction <kbd>N</kbd></button>
          </div>
        </header>

        <section className="stats-grid">
          <StatCard label="Total balance" value={allSummary.balance} type="balance" note="Everything in minus everything out" hidden={!showBalance} />
          <StatCard label="Income this period" value={summary.income} type="income" note={`${summary.savingsRate.toFixed(0)}% stayed with you`} hidden={!showBalance} />
          <StatCard label="Expenses this period" value={summary.expenses} type="expense" note={`${periodRows.filter(t => t.type === 'expense').length} expenses recorded`} hidden={!showBalance} />
        </section>

        <section className="period-row" aria-label="Dashboard controls">
          <div className="periods">{[7, 30, 90].map(value => <button className={days === value ? 'active' : ''} aria-pressed={days === value} onClick={() => setDays(value)} key={value}>{value === 7 ? '7 days' : value === 30 ? 'This month' : '3 months'}</button>)}</div>
          <button className="balance-toggle" aria-pressed={!showBalance} onClick={() => setShowBalance(v => !v)}>{showBalance ? <Eye size={17} /> : <EyeOff size={17} />}{showBalance ? 'Hide values' : 'Show values'}</button>
        </section>

        <button className="mobile-add-button" onClick={() => setEntryOpen(true)} aria-label="Add transaction"><Plus size={21} /><span>Add</span></button>

        <section className="charts-grid dashboard-anchor" ref={insightsRef}>
          <article className="panel flow-panel">
            <div className="panel-head"><div><span className="eyebrow">Cash flow</span><h2>Income and expenses</h2></div><span className="legend"><i className="income-dot" />Income <i className="expense-dot" />Expenses</span></div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%"><AreaChart data={chart} margin={{ left: -18, right: 8, top: 12 }}>
                <defs><linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b8d96f" stopOpacity={0.16}/><stop offset="1" stopColor="#b8d96f" stopOpacity={0}/></linearGradient><linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ef8a71" stopOpacity={0.14}/><stop offset="1" stopColor="#ef8a71" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="#272b29" /><XAxis dataKey="date" tick={{ fill: '#777d79', fontSize: 11 }} axisLine={false} tickLine={false} interval={Math.max(0, Math.floor(days / 6) - 1)} /><YAxis tickFormatter={v => money(v, true, currency)} tick={{ fill: '#777d79', fontSize: 11 }} axisLine={false} tickLine={false} /><Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="income" stroke="#b8d96f" strokeWidth={2.25} fill="url(#incomeFill)" dot={false} activeDot={{ r: 4, strokeWidth: 3, stroke: '#111412' }} />
                <Area type="monotone" dataKey="expenses" stroke="#ef8a71" strokeWidth={2.25} fill="url(#expenseFill)" dot={false} activeDot={{ r: 4, strokeWidth: 3, stroke: '#111412' }} />
              </AreaChart></ResponsiveContainer>
            </div>
          </article>

          <article className="panel category-panel">
            <div className="panel-head"><div><span className="eyebrow">Spending</span><h2>By category</h2></div></div>
            {categories.length ? <><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={categories} dataKey="value" innerRadius={58} outerRadius={81} paddingAngle={3} stroke="none">{categories.map(item => <Cell key={item.name} fill={COLORS[item.name] || COLORS.Other} />)}</Pie><Tooltip formatter={value => money(Number(value ?? 0), false, currency)} /></PieChart></ResponsiveContainer><div className="donut-center"><small>TOTAL</small><b>{money(summary.expenses, true, currency)}</b></div></div><div className="category-list">{categories.slice(0, 4).map(item => <div key={item.name}><span><i style={{ background: COLORS[item.name] || COLORS.Other }} />{item.name}</span><b>{summary.expenses ? ((item.value / summary.expenses) * 100).toFixed(0) : 0}%</b></div>)}</div></> : <div className="empty-chart">No expenses in this period</div>}
          </article>
        </section>

        <section className="lower-grid dashboard-anchor" ref={transactionsRef}>
          <article className="panel transactions-panel">
            <div className="panel-head"><div><span className="eyebrow">Activity</span><h2>Recent transactions</h2></div><label className="search"><Search size={16} /><input aria-label="Search transactions" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
            <div className="transaction-list">{recent.map(row => <div className="transaction" key={row.id}>
              <span className={`transaction-icon ${row.type}`}>{row.type === 'income' ? <ArrowUpRight size={18} /> : <ReceiptText size={18} />}</span>
              <div className="transaction-info"><b>{row.description}</b><span>{row.category} · {format(parseISO(row.date), 'MMM d', { locale: enUS })}</span></div>
              <strong className={row.type}>{row.type === 'income' ? '+' : '−'} {money(row.amount, false, currency)}</strong>
              <button className="delete-button" onClick={() => remove(row.id)} aria-label={`Delete ${row.description}`}><Trash2 size={16} /></button>
            </div>)}</div>
          </article>

          <article className="panel rhythm-panel">
            <div className="panel-head"><div><span className="eyebrow">Spending pace</span><h2>Last 7 days</h2></div><span className="trend-badge">Daily</span></div>
            <div className="bar-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={dailySeries(lastDays(transactions, 7), 7)}><XAxis dataKey="date" tick={{ fill: '#777d79', fontSize: 10 }} axisLine={false} tickLine={false}/><Tooltip content={<CustomTooltip />} cursor={{ fill: '#222724' }} /><Bar dataKey="expenses" fill="#ef8a71" radius={[3, 3, 0, 0]} maxBarSize={25}/></BarChart></ResponsiveContainer></div>
            <div className="daily-avg"><span>Daily average</span><b>{money(weekSpend / 7, false, currency)}</b></div>
          </article>
        </section>
      </main>

      {entryOpen && <AddTransaction onClose={() => setEntryOpen(false)} onAdd={add} />}
      {preferencesOpen && <PreferencesPanel currency={currency} onCurrencyChange={async next => { await secureSet('currency', next); setCurrency(next) }} onClose={() => setPreferencesOpen(false)} onNotice={message => { setToast(message); window.setTimeout(() => setToast(''), 3200) }} />}
      {syncOpen && <SyncPanel transactions={transactions} initialPeer={peer} onClose={() => setSyncOpen(false)} onPaired={setPeer} onMerge={rows => setTransactions(current => mergeTransactions(current, rows))} />}
      {sharedReceipt && (
        <ReceiptReview source={sharedReceipt} onClose={() => setSharedReceipt(null)} onAdd={(row, useAi) => {
          if (storageError) { setToast('Unlock private storage before importing a receipt.'); return }
          void add(row, useAi)
          setSharedReceipt(null)
        }}/>
      )}
      {availableUpdate && <div className="update-notice" role="status">
        <span className="update-notice-icon"><RefreshCw size={17}/></span>
        <div><b>Update available</b><span>Leafy {availableUpdate.latestVersion} is ready to download.</span></div>
        <button type="button" className="view-release-button" onClick={() => void openRelease(availableUpdate.releaseUrl).catch(() => setToast('Could not open GitHub Releases.'))}>View release</button>
        <button type="button" className="dismiss-update" aria-label="Dismiss update notice" onClick={() => setAvailableUpdate(null)}><X size={16}/></button>
      </div>}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
    </CurrencyContext.Provider>
  )
}

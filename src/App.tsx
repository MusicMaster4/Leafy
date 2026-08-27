import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownRight, ArrowLeftRight, ArrowUpRight, Bell, ChevronDown, CircleDollarSign,
  Eye, EyeOff, LayoutDashboard, MoreHorizontal, PieChart as PieIcon, Plus, ReceiptText,
  Search, Settings, Sparkles, Target, Trash2, TrendingUp, WalletCards, X,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { categorySeries, dailySeries, lastDays, money, summarize } from './finance'
import { demoTransactions } from './data'
import { expenseCategories, incomeCategories, type Transaction, type TransactionType } from './types'

const COLORS: Record<string, string> = {
  Alimentação: '#e77742', Moradia: '#6d71dc', Transporte: '#e7b23b', Lazer: '#e65d81',
  Saúde: '#35a88b', Compras: '#7c5cc4', Assinaturas: '#3d91ba', Outros: '#98a09b',
}

function useTransactions() {
  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    try {
      const saved = localStorage.getItem('lumina-transactions')
      return saved ? JSON.parse(saved) : demoTransactions
    } catch { return demoTransactions }
  })
  useEffect(() => localStorage.setItem('lumina-transactions', JSON.stringify(transactions)), [transactions])
  return [transactions, setTransactions] as const
}

function StatCard({ label, value, type, note, hidden }: { label: string; value: number; type: 'balance' | 'income' | 'expense'; note: string; hidden?: boolean }) {
  const Icon = type === 'income' ? ArrowUpRight : type === 'expense' ? ArrowDownRight : WalletCards
  return (
    <div className={`stat-card ${type}`}>
      <div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={18} /></span></div>
      <strong>{hidden ? 'R$ •••••' : money(value)}</strong>
      <small>{note}</small>
    </div>
  )
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return <div className="chart-tooltip"><b>{label}</b>{payload.map((p: any) => <span key={p.name} style={{ color: p.color }}>{p.name}: {money(p.value)}</span>)}</div>
}

function AddTransaction({ onClose, onAdd }: { onClose: () => void; onAdd: (row: Transaction) => void }) {
  const [type, setType] = useState<TransactionType>('expense')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const categories = type === 'expense' ? expenseCategories : incomeCategories
  const [category, setCategory] = useState(categories[0])

  useEffect(() => setCategory(type === 'expense' ? expenseCategories[0] : incomeCategories[0]), [type])
  useEffect(() => document.querySelector<HTMLInputElement>('#amount')?.focus(), [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = Number(amount.replace('.', '').replace(',', '.'))
    if (!value || value <= 0) return
    onAdd({ id: crypto.randomUUID(), type, amount: value, description: description.trim() || category, category, date: format(new Date(), 'yyyy-MM-dd') })
  }

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="quick-entry" onSubmit={submit}>
        <div className="entry-head">
          <div><span className="eyebrow">REGISTRO RÁPIDO</span><h2>O que aconteceu?</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar"><X size={20} /></button>
        </div>
        <div className="type-switch">
          <button type="button" className={type === 'expense' ? 'active expense' : ''} onClick={() => setType('expense')}><ArrowDownRight size={17} /> Gastei</button>
          <button type="button" className={type === 'income' ? 'active income' : ''} onClick={() => setType('income')}><ArrowUpRight size={17} /> Recebi</button>
        </div>
        <label className="amount-field"><span>Valor</span><div><b>R$</b><input id="amount" inputMode="decimal" placeholder="0,00" value={amount} onChange={e => setAmount(e.target.value)} /></div></label>
        <label className="input-label"><span>Descrição <i>opcional</i></span><input placeholder={type === 'expense' ? 'Ex.: almoço, mercado...' : 'Ex.: salário, freelance...'} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <div className="category-field"><span>Categoria</span><div className="category-chips">{categories.map(item => <button type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div></div>
        <button className={`save-button ${type}`} type="submit">Salvar {type === 'expense' ? 'gasto' : 'receita'} <span>↵</span></button>
        <p className="privacy-note">Salvo somente neste dispositivo</p>
      </form>
    </div>
  )
}

export default function App() {
  const [transactions, setTransactions] = useTransactions()
  const [days, setDays] = useState(30)
  const [showBalance, setShowBalance] = useState(true)
  const [entryOpen, setEntryOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const periodRows = useMemo(() => lastDays(transactions, days), [transactions, days])
  const summary = useMemo(() => summarize(periodRows), [periodRows])
  const allSummary = useMemo(() => summarize(transactions), [transactions])
  const chart = useMemo(() => dailySeries(periodRows, days), [periodRows, days])
  const categories = useMemo(() => categorySeries(periodRows), [periodRows])
  const weekSpend = summarize(lastDays(transactions, 7)).expenses
  const recent = transactions
    .filter(t => `${t.description} ${t.category}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7)

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) setEntryOpen(true)
      if (event.key === 'Escape') setEntryOpen(false)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const add = (row: Transaction) => {
    setTransactions(current => [row, ...current])
    setEntryOpen(false)
    setToast(row.type === 'expense' ? 'Gasto registrado' : 'Receita registrada')
    window.setTimeout(() => setToast(''), 2600)
  }
  const remove = (id: string) => setTransactions(current => current.filter(t => t.id !== id))

  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><span className="brand-mark"><Sparkles size={21} /></span><div>Lumina<small>FINANÇAS</small></div></div>
        <nav>
          <button className="active"><LayoutDashboard size={19} />Visão geral</button>
          <button><ArrowLeftRight size={19} />Movimentações</button>
          <button><PieIcon size={19} />Análises</button>
          <button><Target size={19} />Metas <span className="soon">EM BREVE</span></button>
        </nav>
        <div className="side-bottom">
          <div className="weekly-card"><span className="mini-icon"><TrendingUp size={16} /></span><div><small>Gastos em 7 dias</small><b>{money(weekSpend)}</b></div></div>
          <button className="settings"><Settings size={18} />Preferências</button>
          <div className="profile"><span>J</span><div><b>Meu dinheiro</b><small>Dados locais</small></div><MoreHorizontal size={18} /></div>
        </div>
      </aside>

      <main>
        <header>
          <div><p>{format(new Date(), "EEEE, d 'de' MMMM", { locale: ptBR })}</p><h1>Boa tarde <span>— vamos olhar seu dinheiro.</span></h1></div>
          <div className="header-actions"><button className="icon-button"><Bell size={20} /></button><button className="new-button" onClick={() => setEntryOpen(true)}><Plus size={19} />Nova movimentação <kbd>N</kbd></button></div>
        </header>

        <section className="period-row">
          <div className="periods">{[7, 30, 90].map(value => <button className={days === value ? 'active' : ''} onClick={() => setDays(value)} key={value}>{value === 7 ? '7 dias' : value === 30 ? 'Este mês' : '3 meses'}</button>)}</div>
          <button className="balance-toggle" onClick={() => setShowBalance(v => !v)}>{showBalance ? <Eye size={17} /> : <EyeOff size={17} />}{showBalance ? 'Ocultar valores' : 'Mostrar valores'}</button>
        </section>

        <section className="stats-grid">
          <StatCard label="Saldo total" value={allSummary.balance} type="balance" note="Tudo que entrou menos tudo que saiu" hidden={!showBalance} />
          <StatCard label="Entradas no período" value={summary.income} type="income" note={`${summary.savingsRate.toFixed(0)}% ficou com você`} hidden={!showBalance} />
          <StatCard label="Saídas no período" value={summary.expenses} type="expense" note={`${periodRows.filter(t => t.type === 'expense').length} gastos registrados`} hidden={!showBalance} />
        </section>

        <section className="charts-grid">
          <article className="panel flow-panel">
            <div className="panel-head"><div><span className="eyebrow">FLUXO DO DINHEIRO</span><h2>Entradas e saídas</h2></div><span className="legend"><i className="income-dot" />Entradas <i className="expense-dot" />Saídas</span></div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%"><AreaChart data={chart} margin={{ left: -18, right: 8, top: 12 }}>
                <defs><linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2b9c7b" stopOpacity={0.24}/><stop offset="1" stopColor="#2b9c7b" stopOpacity={0}/></linearGradient><linearGradient id="expenseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e26846" stopOpacity={0.18}/><stop offset="1" stopColor="#e26846" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid vertical={false} stroke="#ebe8df" strokeDasharray="4 5" /><XAxis dataKey="date" tick={{ fill: '#8b918c', fontSize: 11 }} axisLine={false} tickLine={false} interval={Math.max(0, Math.floor(days / 6) - 1)} /><YAxis tickFormatter={v => money(v, true)} tick={{ fill: '#8b918c', fontSize: 11 }} axisLine={false} tickLine={false} /><Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="receitas" stroke="#2b9c7b" strokeWidth={2.5} fill="url(#incomeFill)" dot={false} activeDot={{ r: 5, strokeWidth: 3, stroke: '#fff' }} />
                <Area type="monotone" dataKey="gastos" stroke="#e26846" strokeWidth={2.5} fill="url(#expenseFill)" dot={false} activeDot={{ r: 5, strokeWidth: 3, stroke: '#fff' }} />
              </AreaChart></ResponsiveContainer>
            </div>
          </article>

          <article className="panel category-panel">
            <div className="panel-head"><div><span className="eyebrow">PARA ONDE FOI</span><h2>Gastos por categoria</h2></div><button className="icon-button"><MoreHorizontal size={20} /></button></div>
            {categories.length ? <><div className="donut-wrap"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={categories} dataKey="value" innerRadius={58} outerRadius={81} paddingAngle={3} stroke="none">{categories.map(item => <Cell key={item.name} fill={COLORS[item.name] || COLORS.Outros} />)}</Pie><Tooltip formatter={value => money(Number(value ?? 0))} /></PieChart></ResponsiveContainer><div className="donut-center"><small>TOTAL</small><b>{money(summary.expenses, true)}</b></div></div><div className="category-list">{categories.slice(0, 4).map(item => <div key={item.name}><span><i style={{ background: COLORS[item.name] || COLORS.Outros }} />{item.name}</span><b>{summary.expenses ? ((item.value / summary.expenses) * 100).toFixed(0) : 0}%</b></div>)}</div></> : <div className="empty-chart">Nenhum gasto neste período</div>}
          </article>
        </section>

        <section className="lower-grid">
          <article className="panel transactions-panel">
            <div className="panel-head"><div><span className="eyebrow">MOVIMENTAÇÕES</span><h2>Mais recentes</h2></div><label className="search"><Search size={16} /><input placeholder="Buscar" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
            <div className="transaction-list">{recent.map(row => <div className="transaction" key={row.id}>
              <span className={`transaction-icon ${row.type}`}>{row.type === 'income' ? <ArrowUpRight size={18} /> : <ReceiptText size={18} />}</span>
              <div className="transaction-info"><b>{row.description}</b><span>{row.category} · {format(parseISO(row.date), "d 'de' MMM", { locale: ptBR })}</span></div>
              <strong className={row.type}>{row.type === 'income' ? '+' : '−'} {money(row.amount)}</strong>
              <button className="delete-button" onClick={() => remove(row.id)} aria-label={`Excluir ${row.description}`}><Trash2 size={16} /></button>
            </div>)}</div>
          </article>

          <article className="panel rhythm-panel">
            <div className="panel-head"><div><span className="eyebrow">RITMO DE GASTOS</span><h2>Últimos 7 dias</h2></div><span className="trend-badge">ao vivo</span></div>
            <div className="bar-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={dailySeries(lastDays(transactions, 7), 7)}><XAxis dataKey="date" tick={{ fill: '#8b918c', fontSize: 10 }} axisLine={false} tickLine={false}/><Tooltip content={<CustomTooltip />} cursor={{ fill: '#f2efe7' }} /><Bar dataKey="gastos" fill="#e77742" radius={[6, 6, 2, 2]} maxBarSize={25}/></BarChart></ResponsiveContainer></div>
            <div className="daily-avg"><span>Média por dia</span><b>{money(weekSpend / 7)}</b></div>
          </article>
        </section>
      </main>

      <button className="mobile-fab" onClick={() => setEntryOpen(true)}><Plus size={23} /></button>
      {entryOpen && <AddTransaction onClose={() => setEntryOpen(false)} onAdd={add} />}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  )
}

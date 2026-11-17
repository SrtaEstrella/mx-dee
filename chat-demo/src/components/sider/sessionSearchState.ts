import { create } from 'zustand'

type SessionSearchState = { open: boolean }

export const useSessionSearch = create<SessionSearchState>(() => ({ open: false }))

export const openSessionSearch = () => useSessionSearch.setState({ open: true })

export const closeSessionSearch = () => useSessionSearch.setState({ open: false })

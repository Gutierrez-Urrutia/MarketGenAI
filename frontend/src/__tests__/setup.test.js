import { describe, it, expect } from 'vitest'
import { authTokenStore } from '@/api/axios'

describe('vitest setup', () => {
  it('resolves the @ alias and has a DOM (jsdom)', () => {
    sessionStorage.clear()
    localStorage.clear()
    expect(authTokenStore.getAccessToken()).toBeNull()
  })
})

import type { PetApi } from '@shared/ipc'

declare global {
  interface Window {
    pet: PetApi
  }
}

export {}

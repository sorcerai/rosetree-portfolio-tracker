// This file will be auto-generated from Supabase
// Run: npx supabase gen types --lang=typescript --project-id=<project-id> > src/types/supabase.ts

export type Database = {
  public: {
    Tables: {
      users: {
        Row: {
          id: string
          email: string
          role: 'TRADER' | 'COACH' | 'ADMIN'
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          email: string
          role?: 'TRADER' | 'COACH' | 'ADMIN'
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          role?: 'TRADER' | 'COACH' | 'ADMIN'
          created_at?: string
          updated_at?: string
        }
      }
      // Additional tables will be auto-generated
    }
  }
}
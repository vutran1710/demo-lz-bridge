package store

import (
	"encoding/json"
	"os"
)

// Cursor is a crash-safe last-processed-block marker (atomic write via temp + rename).
type Cursor struct {
	path string
}

func NewCursor(path string) *Cursor {
	return &Cursor{path: path}
}

type state struct {
	LastBlock uint64 `json:"lastBlock"`
}

// Load returns the last persisted block, or 0 if absent/unreadable.
func (c *Cursor) Load() uint64 {
	b, err := os.ReadFile(c.path)
	if err != nil {
		return 0
	}
	var s state
	if err := json.Unmarshal(b, &s); err != nil {
		return 0
	}
	return s.LastBlock
}

// Save atomically persists the last processed block.
func (c *Cursor) Save(block uint64) error {
	b, err := json.Marshal(state{LastBlock: block})
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

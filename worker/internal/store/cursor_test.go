package store

import (
	"path/filepath"
	"testing"
)

func TestCursor_loadDefaultZero(t *testing.T) {
	c := NewCursor(filepath.Join(t.TempDir(), "missing.cursor"))
	if got := c.Load(); got != 0 {
		t.Errorf("Load on missing = %d, want 0", got)
	}
}

func TestCursor_saveLoadRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.cursor")
	c := NewCursor(path)
	if err := c.Save(123); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := NewCursor(path).Load(); got != 123 {
		t.Errorf("Load = %d, want 123", got)
	}
	// overwrite
	if err := c.Save(456); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := c.Load(); got != 456 {
		t.Errorf("Load after overwrite = %d, want 456", got)
	}
}

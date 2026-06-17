package pathway

import (
	"os"
	"testing"
)

func TestLoad_singleFromFlatEnv(t *testing.T) {
	os.Setenv("PATHWAYS_JSON", "")
	os.Setenv("SRC_RPC", "http://src")
	os.Setenv("DST_RPC", "http://dst")
	os.Setenv("DST_RECEIVE_LIB", "0xabc")
	os.Setenv("DST_ENDPOINT", "0xdef")
	os.Setenv("CONFIRMATIONS", "3")
	defer func() {
		for _, k := range []string{"SRC_RPC", "DST_RPC", "DST_RECEIVE_LIB", "DST_ENDPOINT", "CONFIRMATIONS"} {
			os.Unsetenv(k)
		}
	}()

	ps, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(ps) != 1 {
		t.Fatalf("want 1 pathway, got %d", len(ps))
	}
	if ps[0].SrcRPC != "http://src" || ps[0].DstReceiveLib != "0xabc" || ps[0].Confirmations != 3 {
		t.Errorf("unexpected pathway: %+v", ps[0])
	}
}

func TestLoad_listFromJSON(t *testing.T) {
	os.Setenv("PATHWAYS_JSON", `[
	  {"srcRpc":"http://a","dstRpc":"http://b","dstReceiveLib":"0x1","dstEndpoint":"0x2"},
	  {"id":"B->C","srcRpc":"http://b","dstRpc":"http://c","dstReceiveLib":"0x3","dstEndpoint":"0x4","confirmations":2}
	]`)
	defer os.Unsetenv("PATHWAYS_JSON")

	ps, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(ps) != 2 {
		t.Fatalf("want 2 pathways, got %d", len(ps))
	}
	if ps[0].ID != "0" || ps[0].Confirmations != 1 { // defaults applied
		t.Errorf("pathway 0 defaults wrong: %+v", ps[0])
	}
	if ps[1].ID != "B->C" || ps[1].Confirmations != 2 {
		t.Errorf("pathway 1 wrong: %+v", ps[1])
	}
}

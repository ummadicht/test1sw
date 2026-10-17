import { test } from "node:test";
import assert from "node:assert/strict";
import { indianMobile } from "./phone.ts";

test("a mobile number reduces to the 10 digits cases store", () => {
  assert.equal(indianMobile("9820012345"), "9820012345");
  assert.equal(indianMobile("98200 12345"), "9820012345", "spaces as people type them");
  assert.equal(indianMobile("+91 98200-12345"), "9820012345", "country code dropped");
  assert.equal(indianMobile(" 91 9820012345"), "9820012345", "a '+' decoded from a query string is a space");
  assert.equal(indianMobile("09820012345"), "9820012345", "trunk 0 dropped");
});

test("anything that is not an Indian mobile is refused, not guessed at", () => {
  assert.equal(indianMobile(""), null);
  assert.equal(indianMobile("982001234"), null, "9 digits");
  assert.equal(indianMobile("98200123456"), null, "11 digits without a trunk 0");
  assert.equal(indianMobile("5820012345"), null, "Indian mobiles start 6–9");
  assert.equal(indianMobile("2224567890"), null, "a landline");
  assert.equal(indianMobile("919820012345678"), null, "too long to be +91 and a number");
  assert.equal(indianMobile("911234567890"), null, "+91 followed by a non-mobile");
  assert.equal(indianMobile(null), null);
  assert.equal(indianMobile(9820012345), null, "a number type is not what a query string carries");
});

"use client";

import type { InputHTMLAttributes } from "react";

/** A whole-rupee text input with a ₹ prefix, for inline price edits in admin tables. */
export function RupeeInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="relative inline-flex items-center">
      <span aria-hidden className="absolute left-2.5 text-muted text-[14px] pointer-events-none">
        ₹
      </span>
      <input inputMode="numeric" {...rest} className={`input num !pl-6 ${className}`} />
    </span>
  );
}

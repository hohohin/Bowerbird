import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return clsx('text-plate-ui', twMerge(clsx(inputs))); }

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { type AuthTokensResponse, type SignupInput, signupSchema } from '@wacrm/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { api, setSession } from '@/lib/api';
import { handleApiError } from '@/lib/forms';

export default function SignupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '', password: '', orgName: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      setSession(
        await api<AuthTokensResponse>('/auth/signup', {
          method: 'POST',
          body: values,
          auth: false,
        }),
      );
      queryClient.clear();
      router.replace('/inbox');
    } catch (err) {
      const apiErr = handleApiError(err, form.setError);
      if (apiErr?.code === 'EMAIL_TAKEN') form.setError('email', { message: apiErr.message });
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your workspace</CardTitle>
        <CardDescription>Start with a free workspace for your team.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="grid gap-4">
          <FormField
            label="Your name"
            autoComplete="name"
            autoFocus
            error={errors.name?.message}
            {...form.register('name')}
          />
          <FormField
            label="Work email"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...form.register('email')}
          />
          <FormField
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 10 characters."
            error={errors.password?.message}
            {...form.register('password')}
          />
          <FormField
            label="Business name"
            autoComplete="organization"
            error={errors.orgName?.message}
            {...form.register('orgName')}
          />
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create workspace'}
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-foreground hover:underline">
              Log in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}

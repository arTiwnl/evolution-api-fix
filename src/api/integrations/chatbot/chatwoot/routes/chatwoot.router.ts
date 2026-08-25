import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { HttpStatus } from '@api/routes/index.router';
import { chatwootController, prismaRepository } from '@api/server.module';
import { Auth, configService } from '@config/env.config';
import { UnauthorizedException } from '@exceptions';
import { chatwootSchema, instanceSchema } from '@validate/validate.schema';
import { NextFunction, Request, RequestHandler, Response, Router } from 'express';

// Chatwoot calls this webhook directly (its automation/webhook URL field is
// plain, no custom headers), so it can't carry the standard apikey header the
// other routes here require. Evolution generates this URL itself (see
// chatwoot.service.ts `create`/`initInstanceChatwoot`) with the instance's own
// token appended as a query param, so we validate against that instead -
// otherwise anyone who guesses the instance name could POST a forged
// `message_type: 'outgoing'` payload and make the connected number send
// arbitrary WhatsApp messages.
async function chatwootWebhookGuard(req: Request, _: Response, next: NextFunction) {
  const instanceName = (req.params as unknown as InstanceDto).instanceName;
  const key = (req.query.apikey as string) || req.get('apikey');
  const globalKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;

  if (key && key === globalKey) {
    return next();
  }

  if (instanceName && key) {
    const instance = await prismaRepository.instance.findUnique({ where: { name: instanceName } });
    if (instance?.token === key) {
      return next();
    }
  }

  throw new UnauthorizedException();
}

export class ChatwootRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('set'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ChatwootDto>({
          request: req,
          schema: chatwootSchema,
          ClassRef: ChatwootDto,
          execute: (instance, data) => chatwootController.createChatwoot(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => chatwootController.findChatwoot(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('webhook'), chatwootWebhookGuard, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance, data) => chatwootController.receiveWebhook(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
